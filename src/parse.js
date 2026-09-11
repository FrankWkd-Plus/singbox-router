/**
 * 多格式节点导入 → sing-box outbound
 *
 * 两条独立通路，互为兜底：
 *   1. proxy-utils (Sub-Store)：覆盖面最广，存在就优先用
 *   2. 本文件自带解析器：URI 分享链接 / Clash YAML / sing-box JSON / JS 对象字面量
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { parseYaml } from './yaml.js'
import { ROOT } from './store.js'

// ---------------------------------------------------------------- proxy-utils

/** 按顺序探测 proxy-utils，用本地已有的那份，省得重复下载 */
const PU_CANDIDATES = [
  path.join(ROOT, 'vendor', 'proxy-utils.esm.mjs'),
  path.join(process.env.HOME || '', 'data', 'third', 'node-convert', 'proxy-utils.esm.mjs')
]

let puPromise = null

/**
 * proxy-utils 是给浏览器打的包，留了两个 Node 下的坑：
 *
 *   1. 残留 CJS 的 `require()` 引用（fs / net / tls / dotenv / undici …），
 *      ESM 下会 ReferenceError。它自己从未声明 require，所以那是全局查找，
 *      挂个 createRequire 垫片即可。
 *   2. 顶层就 require 了 dotenv、cron 这类可选三方包，而我们没有 node_modules。
 *      对解析不到的模块返回一个无副作用的 stub，让模块能求值下去 ——
 *      我们只用纯变换的 parse/produce，用不到那些网络/定时能力。
 *   3. 它载入时会往当前工作目录写 sub-store.json / root.json（缓存脚手架）。
 *      给它一个「文件都不存在」的 fs：写入被吞掉不污染目录，读取抛 ENOENT
 *      让它安静地走「无缓存」分支（若返回 stub 对象，它会 JSON.parse 失败刷错误日志）。
 *
 * 垫片挂上后不摘除：库内部有懒执行的代码路径也需要它。
 */

/** 一个「什么都不存在、写入无效」的 fs 替身 */
function makeFsStub() {
  const enoent = () => {
    const e = new Error('ENOENT: no such file or directory')
    e.code = 'ENOENT'
    e.errno = -2
    throw e
  }
  const asyncEnoent = async () => enoent()
  const noop = () => {}
  const asyncNoop = async () => {}

  const promises = new Proxy(
    {},
    {
      get: (_t, k) => (k === 'readFile' || k === 'stat' || k === 'lstat' || k === 'access' ? asyncEnoent : asyncNoop)
    }
  )

  const overrides = {
    existsSync: () => false,
    readFileSync: enoent,
    statSync: enoent,
    lstatSync: enoent,
    accessSync: enoent,
    readdirSync: () => [],
    promises
  }

  const stub = new Proxy(
    {},
    {
      get: (_t, k) => {
        if (k === 'then') return undefined
        if (k === 'default') return stub
        return k in overrides ? overrides[k] : noop
      }
    }
  )
  return stub
}

function ensureRequireShim() {
  if (typeof globalThis.require !== 'undefined') return
  const real = createRequire(import.meta.url)
  const fsStub = makeFsStub()
  const stub = new Proxy(function () {}, {
    // then 必须返回 undefined，否则 stub 会被误判成 thenable 卡住 await
    get: (_t, k) => (k === 'then' ? undefined : stub),
    apply: () => stub,
    construct: () => stub
  })
  globalThis.require = (id) => {
    if (id === 'fs' || id === 'node:fs') return fsStub
    if (id === 'fs/promises' || id === 'node:fs/promises') return fsStub.promises
    try {
      return real(id)
    } catch {
      return stub
    }
  }
}

/** proxy-utils 每次解析都往 stdout 打日志，用同步作用域静音掉 */
function quiet(fn) {
  const { log, info, debug } = console
  console.log = console.info = console.debug = () => {}
  try {
    return fn()
  } finally {
    Object.assign(console, { log, info, debug })
  }
}

export function loadProxyUtils() {
  if (puPromise) return puPromise
  puPromise = (async () => {
    // proxy-utils 在导入时会全局改写 console（给每行加时间戳前缀），
    // 先存一份原始方法，导入完再还原，免得污染本程序的日志
    const pristine = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug
    }
    try {
      for (const p of PU_CANDIDATES) {
        if (!fs.existsSync(p)) continue
        try {
          ensureRequireShim()
          const mod = await import(pathToFileURL(p).href)
          if (typeof mod.parse === 'function' && typeof mod.produce === 'function') {
            return { parse: mod.parse, produce: mod.produce, path: p }
          }
        } catch {
          // 载入失败就换下一个候选，最终退回自带解析器
        }
      }
      return null
    } finally {
      Object.assign(console, pristine)
    }
  })()
  return puPromise
}

async function tryProxyUtils(text) {
  const pu = await loadProxyUtils()
  if (!pu) return []
  try {
    const proxies = quiet(() => pu.parse(text))
    if (!Array.isArray(proxies) || !proxies.length) return []
    const produced = quiet(() => pu.produce(proxies, 'singbox', 'internal'))
    const list = Array.isArray(produced) ? produced : [produced]
    return list
      .filter((o) => o && o.type && o.server)
      .map((o) => {
        // DNS 由本程序统一管理，节点自带的解析器配置会干扰分流
        delete o.domain_resolver
        return clean(o)
      })
  } catch {
    return []
  }
}

// -------------------------------------------------------------------- 工具

function bool(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'True'
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** "50 Mbps" / "50" / 50 → 50 */
function mbps(v) {
  if (v === undefined || v === null || v === '') return undefined
  const m = /(\d+(?:\.\d+)?)/.exec(String(v))
  return m ? Number(m[1]) : undefined
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function b64decode(s) {
  try {
    let t = String(s).trim().replace(/-/g, '+').replace(/_/g, '/')
    const pad = t.length % 4
    if (pad) t += '='.repeat(4 - pad)
    const out = Buffer.from(t, 'base64').toString('utf8')
    // 解出乱码说明本来就不是 base64
    return /\uFFFD/.test(out) ? '' : out
  } catch {
    return ''
  }
}

/** 递归剔除空值，sing-box 对多余的 null 字段很敏感（保留 0 与 false） */
function clean(v) {
  if (Array.isArray(v)) return v.map(clean).filter((x) => x !== undefined && x !== null)
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, val] of Object.entries(v)) {
      const c = clean(val)
      if (c === undefined || c === null || c === '') continue
      if (Array.isArray(c) && c.length === 0) continue
      if (typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue
      o[k] = c
    }
    return o
  }
  return v
}

function splitHostPort(s) {
  const t = String(s).trim()
  const m = /^\[(.+)\]:(\d+)$/.exec(t)
  if (m) return [m[1], Number(m[2])]
  const i = t.lastIndexOf(':')
  if (i < 0) return [t, 443]
  return [t.slice(0, i), Number(t.slice(i + 1))]
}

function toList(v) {
  if (v === undefined || v === null || v === '') return undefined
  if (Array.isArray(v)) return v.filter(Boolean)
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function buildTLS({ enabled, sni, insecure, alpn, fp, reality }) {
  if (!enabled) return undefined
  const tls = { enabled: true }
  if (sni) tls.server_name = sni
  if (insecure) tls.insecure = true
  const a = toList(alpn)
  if (a) tls.alpn = a
  if (fp) tls.utls = { enabled: true, fingerprint: fp }
  if (reality && reality.publicKey) {
    tls.reality = { enabled: true, public_key: reality.publicKey }
    if (reality.shortId) tls.reality.short_id = reality.shortId
    // sing-box 要求 reality 必须搭配 uTLS 指纹
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: 'chrome' }
  }
  return tls
}

/** 从 URI 查询参数构造 transport */
function transportFromQuery(q) {
  const net = String(q.type || q.net || 'tcp').toLowerCase()
  const rawPath = q.path || ''
  const hostHeader = q.host || ''

  switch (net) {
    case 'ws': {
      const t = { type: 'ws' }
      const [p, query] = String(rawPath).split('?')
      t.path = p || '/'
      if (hostHeader) t.headers = { Host: hostHeader }
      const ed = q.ed || (query ? new URLSearchParams(query).get('ed') : null)
      if (ed) {
        t.max_early_data = num(ed)
        t.early_data_header_name = 'Sec-WebSocket-Protocol'
      }
      return t
    }
    case 'grpc':
      return { type: 'grpc', service_name: q.serviceName || q.servicename || rawPath || '' }
    case 'h2':
    case 'http': {
      const t = { type: 'http' }
      const h = toList(hostHeader)
      if (h) t.host = h
      if (rawPath) t.path = rawPath
      return t
    }
    case 'httpupgrade': {
      const t = { type: 'httpupgrade', path: String(rawPath).split('?')[0] || '/' }
      if (hostHeader) t.host = hostHeader
      return t
    }
    case 'tcp':
      // tcp + http 伪装头
      if (String(q.headerType || '').toLowerCase() === 'http') {
        const t = { type: 'http' }
        const h = toList(hostHeader)
        if (h) t.host = h
        if (rawPath) t.path = rawPath
        return t
      }
      return undefined
    default:
      return undefined
  }
}

function nameFromHash(raw, fallback) {
  const i = raw.indexOf('#')
  if (i < 0) return fallback
  const n = safeDecode(raw.slice(i + 1)).trim()
  return n || fallback
}

// ------------------------------------------------------- URI 分享链接解析

export function parseUri(raw) {
  const uri = String(raw).trim()
  const scheme = (uri.match(/^([a-z0-9+.-]+):\/\//i) || [])[1]
  if (!scheme) return null

  switch (scheme.toLowerCase()) {
    case 'vless':
      return parseVless(uri)
    case 'vmess':
      return parseVmess(uri)
    case 'ss':
      return parseSS(uri)
    case 'trojan':
      return parseTrojan(uri)
    case 'hysteria2':
    case 'hy2':
      return parseHysteria2(uri)
    case 'hysteria':
    case 'hy':
      return parseHysteria1(uri)
    case 'tuic':
      return parseTuic(uri)
    case 'anytls':
      return parseAnytls(uri)
    case 'socks':
    case 'socks5':
    case 'socks5h':
      return parseSocks(uri)
    case 'http':
    case 'https':
      return parseHttpProxy(uri)
    case 'ssr':
      throw new Error('sing-box 不支持 ShadowsocksR')
    case 'wireguard':
      throw new Error('WireGuard 需要用 endpoint 配置，暂不支持从链接导入')
    default:
      return null
  }
}

/** 统一取出 URL 各部分（非特殊 scheme 也能被 WHATWG URL 正确解析） */
function urlParts(uri) {
  const u = new URL(uri)
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const q = Object.fromEntries(u.searchParams)
  return { u, host, q, port: Number(u.port || 443) }
}

function parseVless(uri) {
  const { u, host, q, port } = urlParts(uri)
  const sec = String(q.security || '').toLowerCase()
  return clean({
    type: 'vless',
    tag: nameFromHash(uri, `${host}:${port}`),
    server: host,
    server_port: port,
    uuid: safeDecode(u.username),
    flow: q.flow || undefined,
    packet_encoding: q.packetEncoding || undefined,
    tls: buildTLS({
      enabled: sec === 'tls' || sec === 'reality' || sec === 'xtls',
      sni: q.sni || q.peer || q.host || undefined,
      insecure: bool(q.allowInsecure) || bool(q.insecure),
      alpn: q.alpn,
      fp: q.fp,
      reality: sec === 'reality' ? { publicKey: q.pbk, shortId: q.sid } : null
    }),
    transport: transportFromQuery(q)
  })
}

function parseVmess(uri) {
  const body = uri.slice('vmess://'.length)
  const decoded = b64decode(body.split('#')[0])

  // v2rayN 的 base64(JSON) 形式
  if (decoded && decoded.trim().startsWith('{')) {
    const j = JSON.parse(decoded)
    const tlsOn = j.tls === true || String(j.tls || '').toLowerCase() === 'tls'
    const q = {
      type: j.net || 'tcp',
      path: j.path,
      host: j.host,
      serviceName: j.path,
      headerType: j.type,
      ed: j.ed
    }
    return clean({
      type: 'vmess',
      tag: j.ps || j.remarks || `${j.add}:${j.port}`,
      server: String(j.add || ''),
      server_port: num(j.port) || 443,
      uuid: j.id,
      security: j.scy || j.security || 'auto',
      alter_id: num(j.aid ?? j.alterId) ?? 0,
      tls: buildTLS({
        enabled: tlsOn,
        sni: j.sni || j.host || undefined,
        insecure: bool(j.allowInsecure) || j.verify_cert === false,
        alpn: j.alpn,
        fp: j.fp
      }),
      transport: transportFromQuery(q)
    })
  }

  // vmess://uuid@host:port?... 形式
  const { u, host, q, port } = urlParts(uri)
  const sec = String(q.security || q.encryption || '').toLowerCase()
  return clean({
    type: 'vmess',
    tag: nameFromHash(uri, `${host}:${port}`),
    server: host,
    server_port: port,
    uuid: safeDecode(u.username),
    security: 'auto',
    alter_id: num(q.aid) ?? 0,
    tls: buildTLS({
      enabled: sec === 'tls',
      sni: q.sni || q.peer || q.host,
      insecure: bool(q.allowInsecure),
      alpn: q.alpn,
      fp: q.fp
    }),
    transport: transportFromQuery(q)
  })
}

function parseSS(uri) {
  const name = nameFromHash(uri, '')
  let main = uri.split('#')[0].slice('ss://'.length)

  let pluginStr = ''
  const qi = main.indexOf('?')
  if (qi >= 0) {
    pluginStr = new URLSearchParams(main.slice(qi + 1)).get('plugin') || ''
    main = main.slice(0, qi)
  }

  let cred, hostPort
  const at = main.lastIndexOf('@')
  if (at >= 0) {
    // SIP002：userinfo 可能是 base64，也可能是明文
    const userInfo = main.slice(0, at)
    hostPort = main.slice(at + 1)
    const d = b64decode(userInfo)
    cred = d && d.includes(':') ? d : safeDecode(userInfo)
  } else {
    // 旧版：整段 base64(method:pass@host:port)
    const d = b64decode(main)
    if (!d) throw new Error('ss 链接无法解码')
    const a2 = d.lastIndexOf('@')
    cred = d.slice(0, a2)
    hostPort = d.slice(a2 + 1)
  }

  const ci = cred.indexOf(':')
  if (ci < 0) throw new Error('ss 链接缺少加密方式或密码')
  const [host, port] = splitHostPort(hostPort)

  const ob = {
    type: 'shadowsocks',
    tag: name || `${host}:${port}`,
    server: host,
    server_port: port,
    method: cred.slice(0, ci),
    password: cred.slice(ci + 1)
  }

  if (pluginStr) {
    const [pname, ...opts] = pluginStr.split(';')
    // clash / v2rayN 用 simple-obfs，sing-box 里叫 obfs-local
    ob.plugin = pname === 'simple-obfs' ? 'obfs-local' : pname
    if (opts.length) ob.plugin_opts = opts.join(';')
  }
  return clean(ob)
}

function parseTrojan(uri) {
  const { u, host, q, port } = urlParts(uri)
  return clean({
    type: 'trojan',
    tag: nameFromHash(uri, `${host}:${port}`),
    server: host,
    server_port: port,
    password: safeDecode(u.username),
    tls: buildTLS({
      enabled: true,
      sni: q.sni || q.peer || q.host || host,
      insecure: bool(q.allowInsecure) || bool(q.insecure),
      alpn: q.alpn,
      fp: q.fp
    }),
    transport: transportFromQuery(q)
  })
}

function parseHysteria2(uri) {
  const { u, host, q, port } = urlParts(uri)
  // 认证信息可能是 user 或 user:pass 两段
  const auth = u.password ? `${safeDecode(u.username)}:${safeDecode(u.password)}` : safeDecode(u.username)
  return clean({
    type: 'hysteria2',
    tag: nameFromHash(uri, `${host}:${port}`),
    server: host,
    server_port: port,
    password: auth,
    obfs: q.obfs ? { type: q.obfs, password: q['obfs-password'] || q.obfsParam } : undefined,
    up_mbps: mbps(q.up || q.upmbps),
    down_mbps: mbps(q.down || q.downmbps),
    tls: buildTLS({
      enabled: true,
      sni: q.sni || q.peer || host,
      insecure: bool(q.insecure) || bool(q.allowInsecure),
      alpn: q.alpn
    })
  })
}

function parseHysteria1(uri) {
  const { host, q, port } = urlParts(uri)
  return clean({
    type: 'hysteria',
    tag: nameFromHash(uri, `${host}:${port}`),
    server: host,
    server_port: port,
    auth_str: q.auth || q.authStr || undefined,
    up_mbps: mbps(q.upmbps || q.up),
    down_mbps: mbps(q.downmbps || q.down),
    obfs: q.obfs || undefined,
    tls: buildTLS({
      enabled: true,
      sni: q.peer || q.sni || host,
      insecure: bool(q.insecure),
      alpn: q.alpn
    })
  })
}

function parseTuic(uri) {
  const { u, host, q, port } = urlParts(uri)
  return clean({
    type: 'tuic',
    tag: nameFromHash(uri, `${host}:${port}`),
    server: host,
    server_port: port,
    uuid: safeDecode(u.username),
    password: safeDecode(u.password),
    congestion_control: q.congestion_control || q.congestion || undefined,
    udp_relay_mode: q.udp_relay_mode || undefined,
    tls: buildTLS({
      enabled: true,
      sni: q.sni || q.peer || host,
      insecure: bool(q.allow_insecure) || bool(q.insecure),
      alpn: q.alpn || 'h3'
    })
  })
}

function parseAnytls(uri) {
  const { u, host, q, port } = urlParts(uri)
  return clean({
    type: 'anytls',
    tag: nameFromHash(uri, `${host}:${port}`),
    server: host,
    server_port: port,
    password: safeDecode(u.username) || safeDecode(u.password),
    tls: buildTLS({
      enabled: true,
      sni: q.sni || q.peer || host,
      insecure: bool(q.insecure) || bool(q.allowInsecure)
    })
  })
}

function parseSocks(uri) {
  const { u, host, port } = urlParts(uri)
  return clean({
    type: 'socks',
    tag: nameFromHash(uri, `${host}:${port}`),
    server: host,
    server_port: port,
    version: '5',
    username: safeDecode(u.username) || undefined,
    password: safeDecode(u.password) || undefined
  })
}

function parseHttpProxy(uri) {
  const { u, host, port } = urlParts(uri)
  // http(s):// 有歧义（多半是订阅地址），只有带认证或带 #备注 时才当代理节点
  const hasName = uri.includes('#')
  if (!u.username && !hasName) return null
  const isTls = uri.toLowerCase().startsWith('https://')
  return clean({
    type: 'http',
    tag: nameFromHash(uri, `${host}:${port}`),
    server: host,
    server_port: Number(u.port || (isTls ? 443 : 80)),
    username: safeDecode(u.username) || undefined,
    password: safeDecode(u.password) || undefined,
    tls: isTls ? { enabled: true, server_name: host } : undefined
  })
}

// ------------------------------------------------------------ Clash → sing-box

function clashTransport(p) {
  const net = String(p.network || '').toLowerCase()

  if (net === 'ws') {
    const o = p['ws-opts'] || {}
    const t = { type: 'ws' }
    const [pp, query] = String(o.path || '/').split('?')
    t.path = pp || '/'
    const headers = o.headers || {}
    const hostH = headers.Host || headers.host
    if (hostH) t.headers = { Host: hostH }
    const ed = o['max-early-data'] ?? (query ? new URLSearchParams(query).get('ed') : null)
    if (ed) {
      t.max_early_data = num(ed)
      t.early_data_header_name = o['early-data-header-name'] || 'Sec-WebSocket-Protocol'
    }
    return t
  }
  if (net === 'grpc') {
    return { type: 'grpc', service_name: (p['grpc-opts'] || {})['grpc-service-name'] || '' }
  }
  if (net === 'h2') {
    const o = p['h2-opts'] || {}
    return clean({ type: 'http', host: toList(o.host), path: o.path })
  }
  if (net === 'http') {
    const o = p['http-opts'] || {}
    return clean({ type: 'http', host: toList(o.host), path: Array.isArray(o.path) ? o.path[0] : o.path })
  }
  if (net === 'httpupgrade') {
    const o = p['ws-opts'] || {}
    return clean({ type: 'httpupgrade', path: String(o.path || '/').split('?')[0], host: (o.headers || {}).Host })
  }
  return undefined
}

export function clashToOutbound(p) {
  if (!p || typeof p !== 'object' || !p.server) return null
  const type = String(p.type || '').toLowerCase()
  const tag = p.name || `${p.server}:${p.port}`
  const base = { tag, server: String(p.server), server_port: num(p.port) || 443 }

  const realityOpts = p['reality-opts'] || {}
  const alwaysTls = ['trojan', 'hysteria2', 'hysteria', 'tuic', 'anytls'].includes(type)
  const tls = buildTLS({
    enabled: bool(p.tls) || alwaysTls || !!realityOpts['public-key'],
    sni: p.sni || p.servername || p['server-name'] || (alwaysTls ? p.server : undefined),
    insecure: bool(p['skip-cert-verify']),
    alpn: p.alpn,
    fp: p['client-fingerprint'],
    reality: realityOpts['public-key']
      ? { publicKey: realityOpts['public-key'], shortId: realityOpts['short-id'] }
      : null
  })
  const transport = clashTransport(p)

  switch (type) {
    case 'ss':
    case 'shadowsocks': {
      const ob = { ...base, type: 'shadowsocks', method: p.cipher, password: String(p.password ?? '') }
      if (p.plugin) {
        ob.plugin = p.plugin === 'obfs' || p.plugin === 'simple-obfs' ? 'obfs-local' : p.plugin
        const po = p['plugin-opts'] || {}
        const parts = []
        if (po.mode) parts.push(`obfs=${po.mode}`)
        if (po.host) parts.push(`obfs-host=${po.host}`)
        if (po.path) parts.push(`path=${po.path}`)
        if (parts.length) ob.plugin_opts = parts.join(';')
      }
      return clean(ob)
    }
    case 'vmess':
      return clean({
        ...base,
        type: 'vmess',
        uuid: p.uuid,
        security: p.cipher || 'auto',
        alter_id: num(p.alterId ?? p['alter-id']) ?? 0,
        tls,
        transport
      })
    case 'vless':
      return clean({ ...base, type: 'vless', uuid: p.uuid, flow: p.flow || undefined, tls, transport })
    case 'trojan':
      return clean({ ...base, type: 'trojan', password: String(p.password ?? ''), tls, transport })
    case 'hysteria2':
      return clean({
        ...base,
        type: 'hysteria2',
        password: String(p.password ?? p.auth ?? ''),
        obfs: p.obfs ? { type: p.obfs, password: p['obfs-password'] } : undefined,
        up_mbps: mbps(p.up),
        down_mbps: mbps(p.down),
        tls
      })
    case 'hysteria':
      return clean({
        ...base,
        type: 'hysteria',
        auth_str: p['auth-str'] || p.auth_str || p.auth,
        up_mbps: mbps(p.up),
        down_mbps: mbps(p.down),
        obfs: p.obfs,
        tls
      })
    case 'tuic':
      return clean({
        ...base,
        type: 'tuic',
        uuid: p.uuid,
        password: p.password ? String(p.password) : undefined,
        congestion_control: p['congestion-controller'] || undefined,
        udp_relay_mode: p['udp-relay-mode'] || undefined,
        tls
      })
    case 'anytls':
      return clean({ ...base, type: 'anytls', password: String(p.password ?? ''), tls })
    case 'socks5':
    case 'socks':
      return clean({
        ...base,
        type: 'socks',
        version: '5',
        username: p.username || undefined,
        password: p.password || undefined
      })
    case 'http':
    case 'https':
      return clean({
        ...base,
        type: 'http',
        username: p.username || undefined,
        password: p.password || undefined,
        tls
      })
    default:
      return null
  }
}

// -------------------------------------------------- sing-box JSON / JS 字面量

/** 宽松 JSON：容忍裸键、单引号、注释、尾随逗号。不用 eval。 */
function looseJson(src) {
  let s = String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\w])\/\/[^\n]*/g, '$1')
  s = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, body) => JSON.stringify(body.replace(/\\'/g, "'")))
  s = s.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":')
  s = s.replace(/,\s*([}\]])/g, '$1')
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

const BUILTIN_TYPES = new Set(['selector', 'urltest', 'direct', 'block', 'dns'])

function trySingboxLike(text) {
  // Clash YAML 交给 tryClash，避免 `= { ... }` 的宽松正则误匹配
  if (/(^|\n)\s*proxies\s*:/.test(text)) return []

  let obj = null
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      obj = JSON.parse(text)
    } catch {
      obj = looseJson(text)
    }
  }
  if (!obj) {
    // 形如 `const newProxy = { ... };` 的片段
    const m = /(?:^|=)\s*(\{[\s\S]*\})\s*;?\s*$/.exec(text)
    if (m) obj = looseJson(m[1])
  }
  if (!obj || typeof obj !== 'object') return []

  const candidates = Array.isArray(obj)
    ? obj
    : Array.isArray(obj.outbounds)
      ? obj.outbounds
      : Array.isArray(obj.proxies)
        ? obj.proxies
        : [obj]

  const out = []
  for (const c of candidates) {
    if (!c || typeof c !== 'object' || !c.type || BUILTIN_TYPES.has(c.type)) continue
    if (!c.server) continue
    if (c.server_port !== undefined) {
      // 已经是 sing-box 出站
      out.push(clean({ ...c, tag: c.tag || `${c.server}:${c.server_port}` }))
    } else if (c.port !== undefined) {
      // Clash 风格的对象
      const ob = clashToOutbound(c)
      if (ob) out.push(ob)
    }
  }
  return out
}

function tryClash(text, errors) {
  if (!/(^|\n)\s*proxies\s*:/.test(text)) return []
  let doc
  try {
    doc = parseYaml(text)
  } catch (e) {
    errors.push('YAML 解析失败：' + e.message)
    return []
  }
  const proxies = doc && doc.proxies
  if (!Array.isArray(proxies)) return []

  const out = []
  for (const p of proxies) {
    const ob = clashToOutbound(p)
    if (ob) out.push(ob)
    else if (p && p.type) errors.push(`跳过不支持的类型：${p.name || '?'} (${p.type})`)
  }
  return out
}

function tryUriList(text, errors) {
  let body = text
  // 整段 base64 的订阅内容
  if (!/^[a-z0-9+.-]+:\/\//im.test(text)) {
    const d = b64decode(text.replace(/\s+/g, ''))
    if (d && /[a-z0-9+.-]+:\/\//i.test(d)) body = d
  }

  const out = []
  for (const line of body.split(/[\r\n]+/)) {
    const s = line.trim()
    if (!s || s.startsWith('#') || s.startsWith('//')) continue
    if (!/^[a-z0-9+.-]+:\/\//i.test(s)) continue
    try {
      const ob = parseUri(s)
      if (ob) out.push(ob)
    } catch (e) {
      errors.push(`${s.slice(0, 40)}… → ${e.message}`)
    }
  }
  return out
}

// ------------------------------------------------------------------ 入口

function toNode(ob) {
  return {
    name: ob.tag,
    type: ob.type,
    server: ob.server || '',
    serverPort: ob.server_port || 0,
    outbound: ob
  }
}

/**
 * 识别并导入任意支持的文本格式。
 * @returns {Promise<{nodes: Array, errors: string[], format: string|null}>}
 */
export async function importText(raw) {
  const text = String(raw || '').trim()
  const errors = []
  if (!text) return { nodes: [], errors: ['输入为空'], format: null }

  // sing-box JSON / JS 字面量：proxy-utils 不认这类输入，先自己处理
  const direct = trySingboxLike(text)
  if (direct.length) return { nodes: direct.map(toNode), errors, format: 'sing-box' }

  const viaPU = await tryProxyUtils(text)
  if (viaPU.length) return { nodes: viaPU.map(toNode), errors, format: 'proxy-utils' }

  const clash = tryClash(text, errors)
  if (clash.length) return { nodes: clash.map(toNode), errors, format: 'clash' }

  const uris = tryUriList(text, errors)
  if (uris.length) return { nodes: uris.map(toNode), errors, format: 'uri' }

  if (!errors.length) errors.push('无法识别的格式（支持：订阅 base64 / URI 分享链接 / Clash YAML / sing-box JSON）')
  return { nodes: [], errors, format: null }
}
