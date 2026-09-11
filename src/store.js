/**
 * 状态持久化：设置 / 订阅 / 节点 / 自定义分流规则
 * 单文件 JSON，原子写入。本地单用户工具，同步 IO 足够。
 *
 * 数据目录在 ~/.singbox-router（订阅 token、节点凭据、系统代理备份都在这里，
 * 不能放 ~/.cache —— 那是清理工具会碰的地方）。程序目录（git 仓库）里不再有
 * 任何运行期数据，仓库天然脱敏。
 * 旧版本把数据放在程序目录 data/ 下，启动时一次性迁移（复制不移动，见 migrateLegacyDir）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 旧版本的数据目录（程序目录下），需要一次性迁移 */
export const LEGACY_DATA_DIR = path.join(ROOT, 'data')

/** SBR_DATA_DIR 显式指定时不做迁移 —— 自检靠它拿到一个干净、隔离的目录 */
const EXPLICIT_DIR = !!process.env.SBR_DATA_DIR

export const DATA_DIR = EXPLICIT_DIR
  ? path.resolve(process.env.SBR_DATA_DIR)
  : path.join(os.homedir(), '.singbox-router')

export const STATE_FILE = path.join(DATA_DIR, 'state.json')

/** 规则集（.srs，国内自动分流用）存放处 */
export const RULESET_DIR = path.join(DATA_DIR, 'rulesets')

/** 系统代理默认绕过列表 */
export const DEFAULT_BYPASS = [
  'localhost',
  '127.0.0.0/8',
  '::1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '*.local'
]

function defaultSettings() {
  return {
    webPort: 8899,
    // 主端口：走规则分流（国内直连 / 广告拦截 / 其余走所选节点）
    mainPort: 7890,
    // 每节点独立端口的起始值，按需递增
    portBase: 20800,
    clashApiPort: 19090,
    clashSecret: crypto.randomBytes(16).toString('hex'),
    allowLan: false,
    logLevel: 'info',
    testUrl: 'https://www.gstatic.com/generate_204',
    testTimeout: 3000,
    // 留空则自动探测 sing-box 可执行文件
    corePath: '',
    bypassList: DEFAULT_BYPASS.slice(),
    dnsLocal: '223.5.5.5',
    dnsRemote: '8.8.8.8',
    // 内核启动后自动接管系统代理，停止时自动还原
    autoSetSystemProxy: true,
    // 导入节点时自动分配独立端口
    autoAssignPorts: true,
    // 开机（面板服务启动）后自动拉起内核。静默进行，只在失败时留日志。
    autoStartCore: false,
    // 首次引导走完了没（当前安装早已在用，默认 true）
    onboarded: true,

    // ---- 国内自动分流（GeoIP + GeoSite 规则集，可选）----
    // 开启后：命中 geosite-cn 的域名、命中 geoip-cn 的 IP 走直连，其余走代理。
    // 默认关 —— 本项目的主张仍是「按端口精确分流 + 自定义规则」，自动分流是可选的便利层。
    chinaDirect: false,
    // auto：本地有 .srs 就用本地，没有则让内核自己远程拉
    // local：只用本地文件，缺文件时启动前就报错，绝不产生启动期下载
    // remote：始终远程，内核按 update_interval 自己更新
    rulesetSource: 'auto',
    // 远程模式下的下载源前缀，留空用官方地址；下载内核也复用它
    rulesetMirror: '',
    rulesetUpdateInterval: '7d',

    // ---- TUN 全局透明代理 ----
    // 开启后所有程序（含不认系统代理的 Telegram、CLI 工具）自动走代理。
    // 需要内核具备 CAP_NET_ADMIN：跑一次 scripts/setup-tun.sh 即可，之后启动免密码。
    tunEnabled: false,
    // 用独特名字，避免和 v2rayN 的 singbox_tun 混淆，也方便只清理我们自己的残留
    tunInterface: 'sbr-tun',
    tunAddress: '172.19.0.1/30',
    tunMTU: 9000,
    // system | gvisor | mixed
    tunStack: 'mixed',
    tunStrictRoute: true,
    // 刻意避开 sing-box 默认的 2022/9000 —— v2rayN 等其它 sing-box 客户端用的是默认值，
    // 分开用不同索引后，两边的策略路由互不覆盖，我们的清理也绝不会误删别人的规则
    tunTableIndex: 2023,
    tunRuleIndex: 9100
  }
}

function defaultState() {
  return { settings: defaultSettings(), subs: [], nodes: [], rules: [] }
}

let state = null
let migration = null

/**
 * 把旧的 <程序目录>/data 迁到 ~/.singbox-router。
 *
 * 复制而非移动：老目录原样留着，用户自己决定何时清理 ——
 * 迁移过程中断也不会丢东西。新目录已有状态时一律不覆盖。
 */
export function migrateLegacyDir() {
  if (EXPLICIT_DIR || DATA_DIR === LEGACY_DATA_DIR) return null
  if (migration) return migration

  const src = LEGACY_DATA_DIR
  const dst = DATA_DIR
  const detail = { from: src, to: dst, copied: [], skipped: [] }
  try {
    if (!fs.existsSync(path.join(src, 'state.json'))) {
      migration = null
      return null
    }
    fs.mkdirSync(dst, { recursive: true })

    // 新目录已有状态：说明已经迁移过（或用户主动换过），绝不覆盖
    if (fs.existsSync(path.join(dst, 'state.json'))) {
      detail.skipped.push('目标已有 state.json，不覆盖')
      migration = { done: true, ...detail }
      return migration
    }

    for (const name of fs.readdirSync(src)) {
      const from = path.join(src, name)
      const to = path.join(dst, name)
      try {
        const st = fs.statSync(from)
        // 只搬文件和目录，跳过符号链接之类；browser-profile 这种旧遗留也跳过（76MB 且无引用）
        if (st.isDirectory()) {
          if (name === 'browser-profile') {
            detail.skipped.push(`${name}/（旧版 Chrome 面板遗留，无引用）`)
            continue
          }
          fs.cpSync(from, to, { recursive: true })
          detail.copied.push(name + '/')
        } else if (st.isFile()) {
          fs.copyFileSync(from, to)
          detail.copied.push(name)
        }
      } catch (e) {
        detail.skipped.push(`${name}（${e.message}）`)
      }
    }
    migration = { done: true, ...detail }
    console.log(`  已迁移数据目录：${src} → ${dst}（复制，原目录保留）`)
  } catch (e) {
    migration = { done: false, error: e.message, ...detail }
  }
  return migration
}

/** 最近一次迁移的结果（doctor 展示用；null = 没迁移过 / 不需要） */
export function lastMigration() {
  return migration
}

export function load() {
  if (state) return state
  migrateLegacyDir()
  fs.mkdirSync(DATA_DIR, { recursive: true })
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    // 补齐新增的设置项，老状态文件也能直接用
    state = {
      settings: { ...defaultSettings(), ...(parsed.settings || {}) },
      subs: Array.isArray(parsed.subs) ? parsed.subs : [],
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      rules: Array.isArray(parsed.rules) ? parsed.rules : []
    }
  } catch {
    state = defaultState()
    save()
  }
  return state
}

export function save() {
  if (!state) return
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, STATE_FILE)
}

export function getState() {
  return load()
}

export function settings() {
  return load().settings
}

export function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex')
}

/** 本程序自己占用、不能分给节点的端口 */
function reservedPorts() {
  const s = settings()
  return new Set([s.webPort, s.mainPort, s.clashApiPort].filter(Boolean).map(Number))
}

/**
 * 分配一个未被占用的本地端口。
 * 只保证在本程序的配置内不冲突；系统层面的占用由启动前的探测负责。
 */
export function allocPort(preferred) {
  const s = settings()
  const used = reservedPorts()
  for (const n of load().nodes) if (n.port) used.add(Number(n.port))

  const want = Number(preferred)
  if (want && want > 0 && want < 65536 && !used.has(want)) return want

  let p = Number(s.portBase) || 20800
  while (used.has(p) && p < 65535) p++
  return p
}

/** 生成唯一的 sing-box outbound tag（tag 是配置里的主键，必须唯一） */
export function uniqueTag(base, ignoreId) {
  const taken = new Set(
    load()
      .nodes.filter((n) => n.id !== ignoreId)
      .map((n) => n.tag)
  )
  // 这些是内置 tag，节点不能占用
  for (const t of ['direct', 'proxy', 'auto', 'block', 'dns-out']) taken.add(t)

  let name = String(base || 'node').trim() || 'node'
  if (!taken.has(name)) return name
  let i = 2
  while (taken.has(`${name} #${i}`)) i++
  return `${name} #${i}`
}

export function findNode(id) {
  return load().nodes.find((n) => n.id === id)
}

/**
 * 批量写入节点。同一订阅内按 tag 去重更新，保留用户已分配的端口和开关。
 * @param {Array} parsed parse.js 产出的 {name, type, server, serverPort, outbound}
 * @param {string|null} subId 归属订阅，手动导入为 null
 */
export function addNodes(parsed, subId = null) {
  const st = load()
  const s = st.settings
  const added = []
  const updated = []

  for (const item of parsed) {
    // 同订阅内、同名节点视为同一个（订阅更新时保留本地端口设置）
    const prev = st.nodes.find((n) => n.subId === subId && n.name === item.name)
    if (prev) {
      prev.type = item.type
      prev.server = item.server
      prev.serverPort = item.serverPort
      prev.outbound = { ...item.outbound, tag: prev.tag }
      updated.push(prev)
      continue
    }

    const tag = uniqueTag(item.name)
    const node = {
      id: uid('n'),
      name: item.name,
      tag,
      kind: 'proxy',
      type: item.type,
      server: item.server,
      serverPort: item.serverPort,
      port: s.autoAssignPorts ? allocPort() : 0,
      enabled: true,
      subId,
      outbound: { ...item.outbound, tag },
      delay: null,
      delayAt: null
    }
    st.nodes.push(node)
    added.push(node)
  }

  save()
  return { added, updated }
}

/**
 * 添加一个虚拟【直连】节点。
 * 它没有 outbound，配置生成时直绑内置 direct 出站 ——
 * 于是「从这个端口出去的流量，任何模式下都是直连」。
 */
export function addDirectNode(name) {
  const st = load()
  const tag = uniqueTag((name || '直连').trim() || '直连')
  const node = {
    id: uid('d'),
    name: tag,
    tag,
    kind: 'direct',
    type: 'direct',
    server: '—',
    serverPort: 0,
    port: allocPort(),
    enabled: true,
    subId: null,
    outbound: null,
    delay: null,
    delayAt: null
  }
  st.nodes.push(node)
  save()
  return node
}

export function removeNode(id) {  const st = load()
  const i = st.nodes.findIndex((n) => n.id === id)
  if (i < 0) return false
  st.nodes.splice(i, 1)
  save()
  return true
}

/** 重排所有节点端口，从 portBase 起连续分配（端口表乱了之后一键整理） */
export function reassignPorts() {
  const st = load()
  const used = reservedPorts()
  let p = Number(st.settings.portBase) || 20800
  for (const n of st.nodes) {
    while (used.has(p) && p < 65535) p++
    n.port = p
    used.add(p)
    p++
  }
  save()
  return st.nodes
}

// ------------------------------------------------------- 自定义分流规则

export function rules() {
  return load().rules
}

export function findRule(id) {
  return load().rules.find((r) => r.id === id)
}

/** @param {object} data 已经过 rules.js validateRule 校验的规则内容 */
export function addRule(data) {
  const st = load()
  const rule = {
    id: uid('r'),
    enabled: data.enabled !== false,
    domain: data.domain || [],
    domainRegex: data.domainRegex || [],
    ip: data.ip || [],
    process: data.process || [],
    processPath: data.processPath || [],
    processRegex: data.processRegex || [],
    target: data.target,
    note: data.note || ''
  }
  st.rules.push(rule)
  save()
  return rule
}

export function updateRule(id, patch) {
  const rule = findRule(id)
  if (!rule) return null
  Object.assign(rule, patch)
  save()
  return rule
}

export function removeRule(id) {
  const st = load()
  const i = st.rules.findIndex((r) => r.id === id)
  if (i < 0) return false
  st.rules.splice(i, 1)
  save()
  return true
}

/**
 * 按给定顺序重排规则。规则是「首个匹配生效」，顺序即优先级，
 * 所以这不是外观功能而是语义功能。未列出的规则保持原有相对顺序、排在后面。
 */
export function reorderRules(ids) {
  const st = load()
  const byId = new Map(st.rules.map((r) => [r.id, r]))
  const next = []
  for (const id of ids) {
    const r = byId.get(id)
    if (r && !next.includes(r)) next.push(r)
  }
  for (const r of st.rules) if (!next.includes(r)) next.push(r)
  st.rules = next
  save()
  return st.rules
}
