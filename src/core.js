/**
 * sing-box 内核进程管理 + Clash API 客户端
 */
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { ROOT, DATA_DIR, getState, settings } from './store.js'
import { writeConfig, CONFIG_FILE, validate as validateConfig } from './config.js'
import * as sysproxy from './sysproxy.js'

export const events = new EventEmitter()

const LOG_MAX = 800
const logs = []
let seq = 0

let proc = null
let startedAt = null
let lastError = ''
/** 内核意外退出时不要覆盖用户手动停止的语义 */
let stopping = false

export function pushLog(text, level = 'core') {
  const entry = { seq: ++seq, at: Date.now(), level, text }
  logs.push(entry)
  if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX)
  events.emit('log', entry)
}

export function recentLogs(afterSeq = 0) {
  return logs.filter((l) => l.seq > afterSeq)
}

/** 按行切分子进程输出，处理跨 chunk 的半行 */
function lineSplitter(onLine) {
  let buf = ''
  return (chunk) => {
    buf += chunk.toString('utf8')
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const p of parts) {
      const t = p.replace(/\r$/, '')
      if (t.trim()) onLine(t)
    }
  }
}

// ------------------------------------------------------------------ 内核定位

/** findCore 会被 status() 频繁调用，按 corePath 设置缓存结果 */
let coreCache = { key: null, value: null }

export function findCore() {
  const s = settings()
  if (coreCache.key === (s.corePath || '')) return coreCache.value

  const candidates = [
    s.corePath,
    path.join(ROOT, 'bin', 'sing-box'),
    '/usr/local/bin/sing-box',
    '/usr/bin/sing-box',
    path.join(process.env.HOME || '', '.local', 'bin', 'sing-box')
  ].filter(Boolean)

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'sing-box'))
  }

  let found = null
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      if (fs.statSync(c).isFile()) {
        found = c
        break
      }
    } catch {
      // 继续找下一个
    }
  }

  // 只缓存找到的结果：没找到时不缓存，用户跑完 get-core.sh 后无需重启面板
  if (found) coreCache = { key: s.corePath || '', value: found }
  return found
}

/** 设置里改了内核路径、或刚下载完内核时调用 */
export function clearCoreCache() {
  coreCache = { key: null, value: null }
  capCache = { key: null, value: null }
}

// ------------------------------------------------------------------ TUN 前置

let capCache = { key: null, value: null }

/**
 * TUN 需要 CAP_NET_ADMIN（建网卡 + 改路由表）。
 * root 直接有；普通用户跑一次 scripts/setup-tun.sh 给二进制加 file capability 即可。
 */
export function tunCapability() {
  const core = findCore()
  if (!core) return { ok: false, reason: 'no-core', hint: '请先运行 bash scripts/get-core.sh 下载内核' }
  if (capCache.key === core) return capCache.value

  let result
  if (process.getuid && process.getuid() === 0) {
    result = { ok: true, via: 'root' }
  } else {
    let caps = ''
    try {
      caps = execFileSync('getcap', [core], { encoding: 'utf8', timeout: 4000 })
    } catch {
      // getcap 可能没装，退回提示 setup 脚本
    }
    result = /cap_net_admin/.test(caps)
      ? { ok: true, via: 'setcap' }
      : {
          ok: false,
          reason: 'no-cap',
          hint: '内核缺少 CAP_NET_ADMIN 权限。请执行一次：bash scripts/setup-tun.sh（需要 sudo，之后启动不再需要密码）'
        }
  }
  capCache = { key: core, value: result }
  return result
}

/** 其它正在做全局流量捕获的程序 —— 和我们的 TUN 同时开会导致路由错乱 */
export function globalProxyConflicts() {
  const found = new Map()
  try {
    const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8', timeout: 4000 })
    for (const line of out.split('\n')) {
      if (/v2raya_core|\/usr\/bin\/v2raya\b/.test(line)) {
        found.set('v2rayA', { name: 'v2rayA', how: 'iptables/tproxy 透明代理' })
      } else if (/\/v2rayN\b/.test(line)) {
        found.set('v2rayN', { name: 'v2rayN', how: 'sing-box TUN' })
      } else if (/\b(mihomo|clash-meta|clash)\b/.test(line) && /(-d|--config|-f)\b/.test(line)) {
        found.set('Clash', { name: 'Clash/Mihomo', how: '可能开启了 TUN' })
      }
    }
  } catch {
    // 拿不到进程列表就不做这项检查
  }
  return [...found.values()]
}

/**
 * 残留的 TUN 状态。内核被 SIGKILL 或机器硬崩后，
 * 策略路由会留下来指向已不存在的网卡 —— 那会导致整机断网。
 *
 * 只认我们自己的痕迹：网卡名 + 我们专属的规则索引段。
 * 绝不按 "lookup 2022" 之类的通用特征判断 —— v2rayN 等客户端用的正是默认索引，
 * 那样会把别人正在工作的 TUN 误判成我们的残留。
 */
export function staleTunState() {
  if (proc) return []
  const s = settings()
  const name = s.tunInterface || 'sbr-tun'
  const ruleBase = Number(s.tunRuleIndex) || 9100
  const table = Number(s.tunTableIndex) || 2023
  const issues = []

  try {
    const links = execFileSync('ip', ['-brief', 'link', 'show'], { encoding: 'utf8', timeout: 4000 })
    if (new RegExp('^' + name + '[@:\\s]', 'm').test(links)) issues.push(`残留 TUN 网卡 ${name}`)
  } catch {
    // ip 命令不可用则跳过
  }

  try {
    const rules = execFileSync('ip', ['rule', 'show'], { encoding: 'utf8', timeout: 4000 })
    const ours = rules
      .split('\n')
      .filter((line) => {
        const m = /^(\d+):/.exec(line)
        const inOurRange = m && Number(m[1]) >= ruleBase && Number(m[1]) <= ruleBase + 20
        return inOurRange || line.includes(name) || line.includes(`lookup ${table}`)
      })
      .filter(Boolean)
    if (ours.length) issues.push(`残留策略路由 ${ours.length} 条（规则段 ${ruleBase}+ / 表 ${table}）`)
  } catch {
    // 同上
  }

  return issues
}

/**
 * 子进程探测的短缓存。
 *
 * staleTunState（2 个 ip 子进程）和 globalProxyConflicts（1 个 ps 子进程）
 * 都是给 status() 用的，而 status() 挂在 /api/state 上 —— 面板每 15s 轮询一次，
 * 每个打开的页面每次轮询都白 fork 三个子进程，是常驻 CPU 抖动的主要来源。
 * 5 秒缓存对「提示用户有冲突/残留」这种展示型信息完全够用；
 * start()/stop() 这类真正要拿探测结果做决策的路径强制绕过缓存。
 */
const PROBE_TTL = 5000
let probeCache = { at: 0, stale: [], conflicts: [] }

function probeResults(force = false) {
  if (!force && Date.now() - probeCache.at < PROBE_TTL) return probeCache
  probeCache = {
    at: Date.now(),
    stale: staleTunState(),
    conflicts: globalProxyConflicts()
  }
  return probeCache
}

/** 版本号按路径缓存：/api/state 会被频繁轮询，不能每次都 fork 一个子进程 */
const versionCache = new Map()

export function coreVersion() {
  const core = findCore()
  if (!core) return null
  if (versionCache.has(core)) return versionCache.get(core)
  let v = null
  try {
    v = execFileSync(core, ['version'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0]
  } catch {
    v = null
  }
  versionCache.set(core, v)
  return v
}

// ------------------------------------------------------------------ 端口探测

export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    try {
      srv.listen(Number(port), host)
    } catch {
      resolve(false)
    }
  })
}

/** 内核未运行时，检查即将占用的端口是否已被别的程序拿走 */
export async function busyPorts() {
  const st = getState()
  const s = st.settings
  const want = [
    { port: Number(s.mainPort), who: '主代理端口' },
    { port: Number(s.clashApiPort), who: 'Clash API' }
  ]
  for (const n of st.nodes) {
    if (n.enabled && Number(n.port) > 0) want.push({ port: Number(n.port), who: `节点「${n.name}」` })
  }

  const busy = []
  for (const item of want) {
    if (!item.port) continue
    if (!(await portFree(item.port))) busy.push(item)
  }
  return busy
}

// -------------------------------------------------------------- 启动 / 停止

export function status() {
  const s = settings()
  const probe = probeResults()
  return {
    running: !!proc,
    pid: proc ? proc.pid : null,
    startedAt,
    corePath: findCore(),
    lastError,
    configFile: CONFIG_FILE,
    sysproxy: sysproxy.state(),
    tun: {
      enabled: !!s.tunEnabled,
      interface: s.tunInterface || 'sbr-tun',
      capability: tunCapability(),
      stale: probe.stale,
      // 无关 TUN 是否开启都探测：v2rayA 这类透明代理会把内核自己的出站连接
      // 也劫走，仅系统代理模式一样会因此断网，用户需要看到这个提示
      conflicts: probe.conflicts
    }
  }
}

/** 轮询 Clash API 直到就绪，确认内核真的起来了 */
async function waitReady(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!proc) return false
    try {
      await clashApi('/version', {}, 1500)
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  return false
}

export async function start() {
  if (proc) return { ok: true, already: true, ...status() }

  const core = findCore()
  if (!core) {
    throw new Error('未找到 sing-box 可执行文件。请运行 `bash scripts/get-core.sh`，或在设置里指定内核路径。')
  }

  const busy = await busyPorts()
  if (busy.length) {
    throw new Error('以下端口已被占用：' + busy.map((b) => `${b.port}（${b.who}）`).join('、'))
  }

  // ---- TUN 前置检查：任一不满足都会导致断网或路由错乱，必须拦在启动前 ----
  const s = settings()

  // 残留检查与 TUN 开关无关：残留的策略路由会把内核自己的出站连接也拖进黑洞，
  // 表现是「内核在跑、端口在听，但所有网页都打不开」——正是最难排查的那种。
  // 这里是拿探测结果做拦截决策的地方，必须绕过轮询缓存拿最新值
  const probe = probeResults(true)
  const stale = probe.stale
  if (stale.length) {
    throw new Error(
      '检测到上次 TUN 异常退出的残留：' + stale.join('、') + '。请执行 bash scripts/tun-recover.sh 清理后再启动。'
    )
  }

  if (s.tunEnabled) {
    const cap = tunCapability()
    if (!cap.ok) throw new Error(cap.hint)

    const conflicts = probe.conflicts
    if (conflicts.length) {
      throw new Error(
        '检测到其它全局代理正在运行：' +
          conflicts.map((c) => `${c.name}（${c.how}）`).join('、') +
          '。它们和 TUN 会互相抢路由，请先退出再启动；或在设置里关掉 TUN 只用代理模式。'
      )
    }
  } else {
    // 仅系统代理模式下不硬拦（有些配置确实可以共存），但必须大声警告：
    // v2rayA 的 iptables/tproxy 会劫走 sing-box 自己连节点的流量，整机表现为断网
    const conflicts = probe.conflicts
    if (conflicts.length) {
      pushLog(
        '⚠ 检测到其它代理工具正在运行：' +
          conflicts.map((c) => `${c.name}（${c.how}）`).join('、') +
          '。它们可能劫持本内核连节点的流量，如果网页打不开，请先退出它们。',
        'warn'
      )
    }
  }

  // 配置级问题（端口冲突、规则指向已删节点、国内分流缺规则集…）在启动前拦下：
  // 其中「local 模式缺 .srs」会让内核直接 FATAL，与其让它启动即崩，不如把补齐方法说清楚
  const fatal = validateConfig().filter((i) => i.includes('缺少规则集') || i.includes('被重复占用'))
  if (fatal.length) throw new Error(fatal.join('；'))

  writeConfig()
  lastError = ''
  stopping = false

  pushLog(`启动内核：${core} run -c ${CONFIG_FILE}`, 'info')
  const child = spawn(core, ['run', '--disable-color', '-c', CONFIG_FILE, '-D', DATA_DIR], {
    cwd: DATA_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc = child
  startedAt = Date.now()

  child.stdout.on('data', lineSplitter((l) => pushLog(l)))
  child.stderr.on('data', lineSplitter((l) => pushLog(l)))

  child.on('error', (err) => {
    lastError = err.message
    pushLog('内核启动失败：' + err.message, 'error')
  })

  child.on('exit', async (code, signal) => {
    if (proc === child) proc = null
    startedAt = null
    const how = signal ? `信号 ${signal}` : `退出码 ${code}`
    if (!stopping && code !== 0) {
      lastError = `内核异常退出（${how}）`
      pushLog(lastError, 'error')
    } else {
      pushLog(`内核已停止（${how}）`, 'info')
    }
    // 内核没了，系统代理必须还原，否则整机断网
    await sysproxy.restore().catch((e) => pushLog('还原系统代理失败：' + e.message, 'error'))
    events.emit('status', status())
  })

  const ready = await waitReady()
  if (!ready && !proc) {
    const tail = logs.slice(-8).map((l) => l.text).join('\n')
    throw new Error('内核启动后立即退出。日志：\n' + tail)
  }
  if (!ready) {
    pushLog('Clash API 未在预期时间内就绪，内核可能仍在初始化', 'warn')
  }

  if (s.tunEnabled) {
    // TUN 已经全局捕获，再设系统代理是多余的一层，反而容易让人误判问题出在哪
    pushLog(`TUN 已启用（网卡 ${s.tunInterface || 'sbr-tun'}），跳过系统代理接管`, 'info')
  } else if (s.autoSetSystemProxy) {
    try {
      await sysproxy.apply()
      pushLog('已接管系统代理', 'info')
    } catch (e) {
      pushLog('设置系统代理失败：' + e.message, 'error')
    }
  }

  events.emit('status', status())
  return { ok: true, ...status() }
}

export async function stop() {
  stopping = true
  await sysproxy.restore().catch(() => {})

  if (!proc) {
    events.emit('status', status())
    return { ok: true, already: true }
  }

  const child = proc
  child.kill('SIGTERM')

  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000)
    child.once('exit', () => {
      clearTimeout(t)
      resolve(true)
    })
  })
  if (!exited) {
    pushLog('内核未响应 SIGTERM，强制结束', 'warn')
    child.kill('SIGKILL')
  }

  proc = null
  startedAt = null

  // TUN 退出后必须确认路由已还原，残留会导致整机断网。
  // 内核刚停，绕过缓存重新探测
  const stale = probeResults(true).stale
  if (stale.length) {
    pushLog(
      '⚠ 内核已停止但仍有残留：' + stale.join('、') + '。请执行 bash scripts/tun-recover.sh 恢复网络。',
      'error'
    )
  }

  events.emit('status', status())
  return { ok: true, stale }
}

export async function restart() {
  await stop()
  return start()
}

/** 配置变更后热重载：内核在跑就重启，没跑就只写配置 */
export async function applyChanges() {
  if (proc) return restart()
  writeConfig()
  return { ok: true, restarted: false }
}

// --------------------------------------------------------------- Clash API

export async function clashApi(pathname, init = {}, timeoutMs = 8000) {
  const s = settings()
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${s.clashApiPort}${pathname}`, {
      ...init,
      signal: ac.signal,
      headers: { Authorization: `Bearer ${s.clashSecret}`, ...(init.headers || {}) }
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Clash API ${res.status}: ${text.slice(0, 160)}`)
    return text ? JSON.parse(text) : null
  } finally {
    clearTimeout(timer)
  }
}

/** 测节点延迟（毫秒）。内核未运行时抛错。 */
export async function testDelay(tag) {
  const s = settings()
  const q = new URLSearchParams({ url: s.testUrl, timeout: String(s.testTimeout) })
  const r = await clashApi(`/proxies/${encodeURIComponent(tag)}/delay?${q}`, {}, Number(s.testTimeout) + 3000)
  return r && typeof r.delay === 'number' ? r.delay : null
}

/** 切换主端口所用节点 */
export async function selectProxy(name) {
  return clashApi('/proxies/proxy', {
    method: 'PUT',
    body: JSON.stringify({ name }),
    headers: { 'Content-Type': 'application/json' }
  })
}

export async function currentProxy() {
  if (!proc) return null
  try {
    const r = await clashApi('/proxies/proxy')
    return r ? r.now : null
  } catch {
    return null
  }
}

/** rule / global / direct */
export async function setMode(mode) {
  return clashApi('/configs', {
    method: 'PATCH',
    body: JSON.stringify({ mode }),
    headers: { 'Content-Type': 'application/json' }
  })
}

export async function currentMode() {
  if (!proc) return null
  try {
    const r = await clashApi('/configs')
    return r ? String(r.mode || '').toLowerCase() : null
  } catch {
    return null
  }
}
