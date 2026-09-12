/**
 * singbox-router —— 基于 sing-box 的分流 Web 客户端
 *
 * 只监听回环地址。本 API 能改系统代理、能起停子进程，
 * 所以额外校验 Host / Origin，防止 DNS rebinding 和来自其他站点的跨站调用。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as store from './src/store.js'
import * as parse from './src/parse.js'
import * as subs from './src/subscribe.js'
import * as core from './src/core.js'
import * as sysproxy from './src/sysproxy.js'
import * as setup from './src/setup.js'
import * as doctor from './src/doctor.js'
import * as ruleset from './src/ruleset.js'
import * as termproxy from './src/termproxy.js'
import { listProcesses } from './src/processes.js'
import { openDir } from './src/open.js'
import { buildConfig, validate, isDirectNode } from './src/config.js'
import { validateRule, RULE_TARGETS, describeRule } from './src/rules.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(ROOT, 'public')

/**
 * doctor「一键修」的分发器 —— 面板 / 托盘 / cli 走同一批函数，只有一份实现。
 * 返回值都带 { ok, output? }，失败时把原因说清楚，不假装成功。
 */
async function runFix(action) {
  switch (action) {
    case 'download-core':
      return setup.downloadCore()
    case 'download-rulesets':
      return ruleset.download()
    case 'authorize-tun':
      return setup.authorizeTun()
    case 'recover-tun': {
      // 内核在跑时先停掉 —— 拆路由时内核还开着，行为未定义
      if (core.status().running) await core.stop()
      core.pushLog('执行 TUN 紧急恢复（清理本项目残留的策略路由与网卡）…', 'info')
      const r = await setup.recoverTun()
      dirty = false
      return r
    }
    case 'restart-network':
      return setup.restartNetwork()
    case 'takeover-terminal':
      return termproxy.apply()
    case 'apply':
      await core.applyChanges()
      dirty = false
      return { ok: true, message: '配置已应用' }
    default:
      throw new Error(`修复动作没有实现：${action}`)
  }
}

core.events.setMaxListeners(0)

/** 配置有变更但还没应用到内核 */
let dirty = false
const markDirty = () => {
  dirty = true
}

// ------------------------------------------------------------------ 小工具

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 只接受来自本机、且 Origin 属于自己的请求 */
function guard(req, port) {
  const host = (req.headers.host || '').toLowerCase()
  const hostOk = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host) || host === `127.0.0.1:${port}`
  if (!hostOk) return '拒绝：非本机 Host'

  const origin = req.headers.origin
  if (origin) {
    const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]
    if (!allowed.includes(origin)) return '拒绝：跨站请求'
  }
  return null
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const file = path.join(PUBLIC, rel)
  // 防目录穿越
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    res.writeHead(403).end('forbidden')
    return
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(data)
  })
}

/** 校验端口可用性（配置层面，不查系统占用） */
function validatePort(port, nodeId) {
  const p = Number(port)
  if (p === 0) return null
  if (!Number.isInteger(p) || p < 1 || p > 65535) return '端口必须是 1-65535 的整数'
  const st = store.getState()
  const s = st.settings
  if (p === Number(s.webPort)) return `端口 ${p} 是 Web 面板端口`
  if (p === Number(s.mainPort)) return `端口 ${p} 是主代理端口`
  if (p === Number(s.clashApiPort)) return `端口 ${p} 是 Clash API 端口`
  const clash = st.nodes.find((n) => n.id !== nodeId && Number(n.port) === p)
  if (clash) return `端口 ${p} 已分配给节点「${clash.name}」`
  return null
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

// -------------------------------------------------------------------- 路由

async function handleApi(req, res, url) {
  const p = url.pathname
  const method = req.method

  // ---- 总状态 ----
  if (p === '/api/state' && method === 'GET') {
    const st = store.getState()
    return json(res, 200, {
      settings: st.settings,
      subs: st.subs,
      nodes: st.nodes,
      rules: st.rules,
      status: { ...core.status(), dirty },
      coreVersion: core.coreVersion(),
      issues: validate(),
      proxyUtils: !!(await parse.loadProxyUtils()),
      currentProxy: await core.currentProxy(),
      clashMode: await core.currentMode(),
      // 排查页 / 设置页直接要用的环境信息（都是廉价本地读取，不碰网络）
      dataDir: store.DATA_DIR,
      ruleSets: { items: ruleset.status(), source: ruleset.effectiveSource() },
      termProxy: termproxy.state()
    })
  }

  // ---- 导入 ----
  if (p === '/api/import' && method === 'POST') {
    const { text } = await readBody(req)
    const result = await parse.importText(text)
    if (!result.nodes.length) return json(res, 400, { error: result.errors.join('\n') || '未解析出节点' })
    const { added, updated } = store.addNodes(result.nodes, null)
    markDirty()
    return json(res, 200, {
      added: added.length,
      updated: updated.length,
      format: result.format,
      errors: result.errors
    })
  }

  // ---- 订阅 ----
  if (p === '/api/subs' && method === 'POST') {
    const { name, url: subUrl, ua } = await readBody(req)
    if (!subUrl) return json(res, 400, { error: '缺少订阅地址' })
    const r = await subs.addSub({ name, url: subUrl, ua })
    markDirty()
    return json(res, 200, r)
  }

  let m
  if ((m = /^\/api\/subs\/([^/]+)\/update$/.exec(p)) && method === 'POST') {
    const r = await subs.updateSub(m[1])
    markDirty()
    return json(res, 200, r)
  }
  if ((m = /^\/api\/subs\/([^/]+)$/.exec(p)) && method === 'DELETE') {
    const keep = url.searchParams.get('keepNodes') === '1'
    const ok = subs.removeSub(m[1], keep)
    if (!ok) return json(res, 404, { error: '订阅不存在' })
    markDirty()
    return json(res, 200, { ok: true })
  }

  // ---- 节点 ----
  if ((m = /^\/api\/nodes\/([^/]+)$/.exec(p)) && method === 'PATCH') {
    const node = store.findNode(m[1])
    if (!node) return json(res, 404, { error: '节点不存在' })
    const body = await readBody(req)

    if (body.port !== undefined) {
      const err = validatePort(body.port, node.id)
      if (err) return json(res, 400, { error: err })
      node.port = Number(body.port)
    }
    if (body.enabled !== undefined) node.enabled = !!body.enabled
    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (!name) return json(res, 400, { error: '节点名不能为空' })
      node.name = name
      node.tag = store.uniqueTag(name, node.id)
      node.outbound = { ...node.outbound, tag: node.tag }
    }
    store.save()
    markDirty()
    return json(res, 200, node)
  }

  if ((m = /^\/api\/nodes\/([^/]+)$/.exec(p)) && method === 'DELETE') {
    if (!store.removeNode(m[1])) return json(res, 404, { error: '节点不存在' })
    markDirty()
    return json(res, 200, { ok: true })
  }

  if (p === '/api/nodes/reassign-ports' && method === 'POST') {
    const nodes = store.reassignPorts()
    markDirty()
    return json(res, 200, { nodes })
  }

  // ---- 虚拟【直连】节点：走它的端口，任何模式下都直连 ----
  if (p === '/api/nodes/direct' && method === 'POST') {
    const { name } = await readBody(req)
    const node = store.addDirectNode(name)
    markDirty()
    return json(res, 200, node)
  }

  // ---- 延迟测试（依赖 Clash API，需内核在跑） ----
  if ((m = /^\/api\/nodes\/([^/]+)\/test$/.exec(p)) && method === 'POST') {
    const node = store.findNode(m[1])
    if (!node) return json(res, 404, { error: '节点不存在' })
    if (isDirectNode(node)) return json(res, 400, { error: '直连节点无需测速' })
    if (!core.status().running) return json(res, 409, { error: '内核未运行，无法测速' })
    try {
      node.delay = await core.testDelay(node.tag)
    } catch {
      node.delay = null
    }
    node.delayAt = Date.now()
    store.save()
    return json(res, 200, { id: node.id, delay: node.delay })
  }

  if (p === '/api/nodes/test-all' && method === 'POST') {
    if (!core.status().running) return json(res, 409, { error: '内核未运行，无法测速' })
    const st = store.getState()
    const targets = st.nodes.filter((n) => n.enabled && !isDirectNode(n))
    await mapLimit(targets, 8, async (node) => {
      try {
        node.delay = await core.testDelay(node.tag)
      } catch {
        node.delay = null
      }
      node.delayAt = Date.now()
    })
    store.save()
    return json(res, 200, { results: targets.map((n) => ({ id: n.id, delay: n.delay })) })
  }

  // ---- 自定义分流规则（进程 / IP / 域名，域名与进程路径支持正则） ----
  if (p === '/api/rules' && method === 'POST') {
    const body = await readBody(req)
    const { rule, error } = validateRule(body, store.getState().nodes)
    if (error) return json(res, 400, { error })
    const saved = store.addRule(rule)
    markDirty()
    return json(res, 200, saved)
  }

  if ((m = /^\/api\/rules\/([^/]+)$/.exec(p)) && method === 'PATCH') {
    const prev = store.findRule(m[1])
    if (!prev) return json(res, 404, { error: '规则不存在' })
    const body = await readBody(req)

    // 只改开关时不必重新校验匹配内容（内容没动）
    const onlyToggle = Object.keys(body).every((k) => k === 'enabled')
    if (onlyToggle) {
      const updated = store.updateRule(prev.id, { enabled: !!body.enabled })
      markDirty()
      return json(res, 200, updated)
    }

    const merged = { ...prev, ...body }
    const { rule, error } = validateRule(merged, store.getState().nodes)
    if (error) return json(res, 400, { error })
    const updated = store.updateRule(prev.id, rule)
    markDirty()
    return json(res, 200, updated)
  }

  if ((m = /^\/api\/rules\/([^/]+)$/.exec(p)) && method === 'DELETE') {
    if (!store.removeRule(m[1])) return json(res, 404, { error: '规则不存在' })
    markDirty()
    return json(res, 200, { ok: true })
  }

  // 顺序即优先级（首个匹配生效），所以排序是语义操作而非外观操作
  if (p === '/api/rules/reorder' && method === 'POST') {
    const { ids } = await readBody(req)
    if (!Array.isArray(ids)) return json(res, 400, { error: '需要 ids 数组' })
    const rules = store.reorderRules(ids.map(String))
    markDirty()
    return json(res, 200, { rules })
  }

  // ---- 设置 ----
  if (p === '/api/settings' && method === 'PATCH') {
    const body = await readBody(req)
    const s = store.settings()
    const numeric = ['mainPort', 'clashApiPort', 'portBase', 'testTimeout', 'tunMTU', 'tunTableIndex', 'tunRuleIndex']
    for (const k of numeric) {
      if (body[k] === undefined) continue
      const v = Number(body[k])
      if (!Number.isInteger(v) || v < 1 || v > 65535) return json(res, 400, { error: `${k} 取值非法` })
      s[k] = v
    }
    for (const k of ['allowLan', 'autoSetSystemProxy', 'autoAssignPorts', 'tunEnabled', 'tunStrictRoute', 'autoStartCore']) {
      if (body[k] !== undefined) s[k] = !!body[k]
    }
    for (const k of ['logLevel', 'testUrl', 'corePath', 'dnsLocal', 'dnsRemote', 'tunInterface', 'tunAddress', 'tunStack']) {
      if (body[k] !== undefined) s[k] = String(body[k]).trim()
    }
    if (body.bypassList !== undefined) {
      s.bypassList = Array.isArray(body.bypassList)
        ? body.bypassList.map((x) => String(x).trim()).filter(Boolean)
        : String(body.bypassList)
            .split(/[,\n]/)
            .map((x) => x.trim())
            .filter(Boolean)
    }
    store.save()
    markDirty()
    core.clearCoreCache()
    return json(res, 200, s)
  }

  // ---- 内核控制 ----
  if (p === '/api/core/start' && method === 'POST') {
    const r = await core.start()
    dirty = false
    return json(res, 200, r)
  }
  if (p === '/api/core/stop' && method === 'POST') {
    return json(res, 200, await core.stop())
  }
  if (p === '/api/core/restart' && method === 'POST') {
    const r = await core.restart()
    dirty = false
    return json(res, 200, r)
  }
  if (p === '/api/core/apply' && method === 'POST') {
    const r = await core.applyChanges()
    dirty = false
    return json(res, 200, r)
  }

  // ---- 配置预览 ----
  if (p === '/api/config' && method === 'GET') {
    return json(res, 200, buildConfig())
  }

  // ---- 安装 / 授权 / 排查（原 scripts/*.sh 的接口版，doctor 的 fix 也走这里）----
  if (p === '/api/core/download' && method === 'POST') {
    const body = await readBody(req)
    const r = await setup.downloadCore({ mirror: body.mirror, version: body.version, dir: body.dir })
    core.clearCoreCache()
    return json(res, 200, { ...r, coreStatus: core.status() })
  }

  if (p === '/api/tun/authorize' && method === 'POST') {
    const r = await setup.authorizeTun()
    return json(res, r.ok ? 200 : 502, { ...r, capability: core.tunCapability() })
  }

  // TUN 残留急救（原 tun-recover.sh，doctor 的 fix:recover-tun 也调它）
  if (p === '/api/tun/recover' && method === 'POST') {
    if (core.status().running) await core.stop()
    core.pushLog('执行 TUN 紧急恢复（清理本项目残留的策略路由与网卡）…', 'info')
    const r = await setup.recoverTun()
    dirty = false
    return json(res, r.ok ? 200 : 502, { ...r, stale: core.staleTunState() })
  }

  if (p === '/api/network/restart' && method === 'POST') {
    const r = await setup.restartNetwork()
    return json(res, r.ok ? 200 : 502, r)
  }

  // ---- 规则集（国内自动分流）----
  if (p === '/api/rulesets' && method === 'GET') {
    return json(res, 200, { items: ruleset.status(), allPresent: ruleset.allPresent() })
  }
  if (p === '/api/rulesets/update' && method === 'POST') {
    const r = await ruleset.download()
    return json(res, r.ok ? 200 : 502, { ...r, items: ruleset.status() })
  }

  // ---- 终端代理 ----
  if (p === '/api/termproxy' && method === 'GET') {
    return json(res, 200, termproxy.state())
  }
  if (p === '/api/termproxy' && method === 'POST') {
    const { on } = await readBody(req)
    const r = on ? termproxy.apply() : termproxy.restore()
    return json(res, r.ok ? 200 : 400, r)
  }

  // ---- 运行中的进程清单（规则页进程树选择器用）----
  if (p === '/api/processes' && method === 'GET') {
    return json(res, 200, { processes: listProcesses() })
  }

  // ---- 打开配置文件夹 ----
  if (p === '/api/open/config-dir' && method === 'POST') {
    try {
      return json(res, 200, await openDir(store.DATA_DIR))
    } catch (e) {
      return json(res, 500, { error: e.message, path: e.path || store.DATA_DIR })
    }
  }

  // ---- 问题排查 ----
  if (p === '/api/doctor' && method === 'GET') {
    const r = await doctor.run({ dirty })
    return json(res, 200, { ...r, text: doctor.textReport(r) })
  }
  if (p === '/api/doctor/fix' && method === 'POST') {
    const { action } = await readBody(req)
    if (!doctor.FIX_ACTIONS.includes(action)) return json(res, 400, { error: `不认识的修复动作：${action}` })
    try {
      return json(res, 200, await runFix(action))
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message })
    }
  }

  // ---- 系统代理 ----
  if (p === '/api/sysproxy' && method === 'POST') {
    const { on } = await readBody(req)
    if (on) {
      // 接管就是「把整机的浏览器流量指到这个端口」。端口没人监听 = 浏览器完全断网，
      // 这是比「没开代理」严重得多的事故，所以宁可拦下来也不许指空
      if (!core.status().running) {
        return json(res, 409, { error: '内核未运行，先启动内核再接管系统代理（否则浏览器会指向一个死端口，整机断网）' })
      }
      const r = await sysproxy.apply()
      return json(res, 200, r)
    }
    return json(res, 200, await sysproxy.restore())
  }

  // ---- 主端口所用节点 / 分流模式 ----
  if (p === '/api/proxy/select' && method === 'POST') {
    const { name } = await readBody(req)
    if (!name) return json(res, 400, { error: '缺少节点名' })
    await core.selectProxy(name)
    return json(res, 200, { ok: true, now: await core.currentProxy() })
  }
  if (p === '/api/mode' && method === 'POST') {
    const { mode } = await readBody(req)
    if (!['rule', 'global', 'direct'].includes(mode)) return json(res, 400, { error: '模式非法' })
    await core.setMode(mode)
    return json(res, 200, { ok: true, mode })
  }

  // ---- 日志流 ----
  if (p === '/api/logs/stream' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    const after = Number(url.searchParams.get('after') || 0)
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

    for (const l of core.recentLogs(after)) send('log', l)
    send('status', { ...core.status(), dirty })

    const onLog = (l) => send('log', l)
    const onStatus = (s) => send('status', { ...s, dirty })
    core.events.on('log', onLog)
    core.events.on('status', onStatus)

    const ka = setInterval(() => res.write(': ping\n\n'), 25000)
    req.on('close', () => {
      clearInterval(ka)
      core.events.off('log', onLog)
      core.events.off('status', onStatus)
    })
    return undefined
  }

  return json(res, 404, { error: '未知接口' })
}

// -------------------------------------------------------------------- 启动

const PORT = Number(process.env.PORT) || store.settings().webPort

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  const denied = guard(req, PORT)
  if (denied) return json(res, 403, { error: denied })

  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname)

  try {
    await handleApi(req, res, url)
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message || String(e) })
    else res.end()
  }
})

// 上次异常退出可能残留了系统代理，内核此刻并没在跑，必须先还原
await sysproxy.restoreIfStale().catch(() => {})
store.load()

/**
 * 系统代理看门狗。
 *
 * 「已接管系统代理」+「内核不在跑」= 浏览器指着死端口，整机断网 ——
 * 这正是「仅系统代理模式完全上不了网」的那类事故。正常路径本来都有还原
 * （内核退出钩子 / 面板退出钩子 / 开机 restoreIfStale），但任何一条走不到
 * （面板被 SIGKILL、DBus 卡死、内核被 OOM 杀掉后钩子异常……）都会把机器
 * 留在断网状态。这里兜底：发现这种组合持续超过宽限时间就自动还原。
 *
 * 宽限 30s 而不是立即还原：重启内核的间隙不该误触发。
 */
let sysproxyDownSince = null
setInterval(async () => {
  try {
    const managed = sysproxy.state().managed
    const running = core.status().running
    if (managed && running) {
      sysproxyDownSince = null
      return
    }
    if (!managed || running) {
      sysproxyDownSince = null
      return
    }
    if (!sysproxyDownSince) {
      sysproxyDownSince = Date.now()
      return
    }
    if (Date.now() - sysproxyDownSince < 30000) return
    console.log('  ⚠ 系统代理仍指向本机端口但内核未运行，自动还原（看门狗）')
    await sysproxy.restore()
    sysproxyDownSince = null
  } catch {
    // 看门狗自身绝不抛出
  }
}, 10000)

/**
 * 开机自启内核（静默）。
 *
 * 不能一上来就启：服务虽然 After=network-online.target，但那不保证真的能出网，
 * 而 TUN 起来时要解析 DNS、连节点。所以留一点缓冲并重试几次。
 * 权限缺失、与其它全局代理冲突这类错误重试也没用，直接放弃并留日志。
 */
async function autoStartCore() {
  if (!store.settings().autoStartCore) return

  const FATAL = /CAP_NET_ADMIN|全局代理|残留|可执行文件/
  for (let attempt = 1; attempt <= 8; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 1 ? 4000 : 5000))
    try {
      await core.start()
      dirty = false
      console.log('  自启内核成功')
      return
    } catch (e) {
      const msg = e.message || String(e)
      if (FATAL.test(msg)) {
        console.log(`  自启内核放弃（需人工处理）：${msg.split('\n')[0]}`)
        return
      }
      if (attempt === 8) console.log(`  自启内核失败，已重试 ${attempt} 次：${msg.split('\n')[0]}`)
    }
  }
}

server.listen(PORT, '127.0.0.1', () => {
  const corePath = core.findCore()
  console.log(`\n  singbox-router 已启动`)
  console.log(`  面板       http://127.0.0.1:${PORT}`)
  console.log(`  主代理端口 127.0.0.1:${store.settings().mainPort}`)
  console.log(`  sing-box   ${corePath || '未找到（请运行 bash scripts/get-core.sh）'}\n`)
  if (store.settings().autoStartCore) {
    console.log('  已开启开机自启内核，稍后静默启动…')
    autoStartCore()
  }
})

/** 退出前务必还原系统代理并收掉内核 */
let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n收到 ${signal}，正在停止内核并还原系统代理…`)
  try {
    await core.stop()
  } catch (e) {
    console.error('停止内核出错：', e.message)
  }
  server.close()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
