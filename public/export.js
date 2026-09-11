/**
 * 节点导出：sing-box outbound → 分享链接（URI）。
 *
 * 这是 src/parse.js 的逆运算，参数名刻意与那边的解析分支一一对应，
 * 保证「导出再导入」能拿回同一个 outbound。改这里时请同步看那边。
 *
 * 放在前端而不是后端：/api/state 已经把每个节点完整的 outbound 发给浏览器了，
 * 纯前端实现不需要重启面板 —— 重启会连带停掉内核子进程和 TUN。
 */

// -------------------------------------------------------------------- 工具

/** URL 编码，但保留分享链接里习惯不转义的字符 */
function enc(s) {
  return encodeURIComponent(String(s))
}

/** IPv6 字面量在 URI 里要套方括号 */
function hostPart(server) {
  const s = String(server || '')
  return s.includes(':') && !s.startsWith('[') ? `[${s}]` : s
}

/** UTF-8 安全的 base64（btoa 只吃 latin1） */
function b64encode(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function qs(pairs) {
  const parts = []
  for (const [k, v] of pairs) {
    if (v === undefined || v === null || v === '' || v === false) continue
    parts.push(`${k}=${enc(v)}`)
  }
  return parts.length ? '?' + parts.join('&') : ''
}

const alpnStr = (tls) => (tls && Array.isArray(tls.alpn) && tls.alpn.length ? tls.alpn.join(',') : undefined)
const fpOf = (tls) => (tls && tls.utls && tls.utls.enabled ? tls.utls.fingerprint : undefined)

/**
 * transport → 查询参数。对应 parse.js 的 transportFromQuery。
 * 没有 transport 时按 tcp 处理（不写 type，兼容性最好）。
 */
function transportParams(tr) {
  if (!tr || !tr.type) return []
  switch (tr.type) {
    case 'ws': {
      const out = [['type', 'ws'], ['path', tr.path || '/']]
      if (tr.headers && tr.headers.Host) out.push(['host', tr.headers.Host])
      if (tr.max_early_data) out.push(['ed', tr.max_early_data])
      return out
    }
    case 'grpc':
      return [['type', 'grpc'], ['serviceName', tr.service_name || '']]
    case 'http': {
      // parse.js 把 h2 与 tcp+http 伪装头都归到 type: 'http'，
      // 回写成 type=http，那边解析时同样落回 http，语义闭合
      const out = [['type', 'http']]
      if (Array.isArray(tr.host) && tr.host.length) out.push(['host', tr.host.join(',')])
      if (tr.path) out.push(['path', tr.path])
      return out
    }
    case 'httpupgrade': {
      const out = [['type', 'httpupgrade'], ['path', tr.path || '/']]
      if (tr.host) out.push(['host', tr.host])
      return out
    }
    default:
      return [['type', tr.type]]
  }
}

/** TLS → 查询参数。security 的取值交给各协议自己决定。 */
function tlsParams(tls, { security } = {}) {
  if (!tls || !tls.enabled) return []
  const out = []
  const reality = tls.reality && tls.reality.enabled
  if (security !== false) out.push(['security', security || (reality ? 'reality' : 'tls')])
  if (tls.server_name) out.push(['sni', tls.server_name])
  if (tls.insecure) out.push(['allowInsecure', '1'])
  const a = alpnStr(tls)
  if (a) out.push(['alpn', a])
  const fp = fpOf(tls)
  if (fp) out.push(['fp', fp])
  if (reality) {
    out.push(['pbk', tls.reality.public_key])
    if (tls.reality.short_id) out.push(['sid', tls.reality.short_id])
  }
  return out
}

// ---------------------------------------------------------------- 各协议

function vlessUri(o, name) {
  const params = [
    ...tlsParams(o.tls),
    ['flow', o.flow],
    ['packetEncoding', o.packet_encoding],
    ...transportParams(o.transport)
  ]
  return `vless://${enc(o.uuid)}@${hostPart(o.server)}:${o.server_port}${qs(params)}#${enc(name)}`
}

/**
 * vmess 用 v2rayN 的 base64(JSON) 形式 —— 客户端支持面最广，
 * 也是 parse.js 里优先识别的那一支。
 */
function vmessUri(o, name) {
  const tr = o.transport || {}
  const tls = o.tls || {}
  const j = {
    v: '2',
    ps: name,
    add: o.server,
    port: String(o.server_port),
    id: o.uuid,
    aid: String(o.alter_id ?? 0),
    scy: o.security || 'auto',
    net: tr.type === 'httpupgrade' ? 'httpupgrade' : tr.type || 'tcp',
    type: 'none',
    host: '',
    path: '',
    tls: tls.enabled ? 'tls' : '',
    sni: tls.enabled ? tls.server_name || '' : '',
    alpn: alpnStr(tls) || '',
    fp: fpOf(tls) || ''
  }

  if (tr.type === 'ws') {
    j.path = tr.path || '/'
    j.host = (tr.headers && tr.headers.Host) || ''
    if (tr.max_early_data) j.ed = String(tr.max_early_data)
  } else if (tr.type === 'grpc') {
    j.path = tr.service_name || ''
  } else if (tr.type === 'http') {
    // parse.js 对 net:'http' 会走 transportFromQuery 的 http 分支
    j.path = tr.path || ''
    j.host = Array.isArray(tr.host) ? tr.host.join(',') : tr.host || ''
  } else if (tr.type === 'httpupgrade') {
    j.path = tr.path || '/'
    j.host = tr.host || ''
  }

  if (tls.insecure) j.allowInsecure = '1'
  return 'vmess://' + b64encode(JSON.stringify(j))
}

/** shadowsocks 用 SIP002：base64(method:password)@host:port */
function ssUri(o, name) {
  const cred = b64encode(`${o.method}:${o.password}`).replace(/=+$/, '')
  let plugin = ''
  if (o.plugin) {
    // 导入时把 simple-obfs 归一成了 obfs-local，导出保持 sing-box 的写法
    const opts = o.plugin_opts ? ';' + o.plugin_opts : ''
    plugin = `?plugin=${enc(o.plugin + opts)}`
  }
  return `ss://${cred}@${hostPart(o.server)}:${o.server_port}${plugin}#${enc(name)}`
}

function trojanUri(o, name) {
  // trojan 恒为 TLS，security 参数是多余的，省掉更贴近主流客户端的写法
  const params = [...tlsParams(o.tls, { security: false }), ...transportParams(o.transport)]
  return `trojan://${enc(o.password)}@${hostPart(o.server)}:${o.server_port}${qs(params)}#${enc(name)}`
}

function hysteria2Uri(o, name) {
  const tls = o.tls || {}
  const params = [
    ['sni', tls.server_name],
    ['insecure', tls.insecure ? '1' : undefined],
    ['alpn', alpnStr(tls)],
    ['obfs', o.obfs && o.obfs.type],
    ['obfs-password', o.obfs && o.obfs.password],
    ['up', o.up_mbps],
    ['down', o.down_mbps]
  ]
  // password 可能是 "user:pass" 两段，按 userinfo 原样写回
  const auth = String(o.password || '')
    .split(':')
    .map(enc)
    .join(':')
  return `hysteria2://${auth}@${hostPart(o.server)}:${o.server_port}${qs(params)}#${enc(name)}`
}

function hysteriaUri(o, name) {
  const tls = o.tls || {}
  const params = [
    ['auth', o.auth_str],
    ['peer', tls.server_name],
    ['insecure', tls.insecure ? '1' : undefined],
    ['alpn', alpnStr(tls)],
    ['upmbps', o.up_mbps],
    ['downmbps', o.down_mbps],
    ['obfs', o.obfs]
  ]
  return `hysteria://${hostPart(o.server)}:${o.server_port}${qs(params)}#${enc(name)}`
}

function tuicUri(o, name) {
  const tls = o.tls || {}
  const params = [
    ['sni', tls.server_name],
    ['insecure', tls.insecure ? '1' : undefined],
    ['alpn', alpnStr(tls)],
    ['congestion_control', o.congestion_control],
    ['udp_relay_mode', o.udp_relay_mode]
  ]
  return `tuic://${enc(o.uuid)}:${enc(o.password)}@${hostPart(o.server)}:${o.server_port}${qs(params)}#${enc(name)}`
}

function anytlsUri(o, name) {
  const tls = o.tls || {}
  const params = [
    ['sni', tls.server_name],
    ['insecure', tls.insecure ? '1' : undefined]
  ]
  return `anytls://${enc(o.password)}@${hostPart(o.server)}:${o.server_port}${qs(params)}#${enc(name)}`
}

function socksUri(o, name) {
  const auth = o.username ? `${enc(o.username)}:${enc(o.password || '')}@` : ''
  return `socks5://${auth}${hostPart(o.server)}:${o.server_port}#${enc(name)}`
}

function httpUri(o, name) {
  const scheme = o.tls && o.tls.enabled ? 'https' : 'http'
  const auth = o.username ? `${enc(o.username)}:${enc(o.password || '')}@` : ''
  return `${scheme}://${auth}${hostPart(o.server)}:${o.server_port}#${enc(name)}`
}

const WRITERS = {
  vless: vlessUri,
  vmess: vmessUri,
  shadowsocks: ssUri,
  trojan: trojanUri,
  hysteria2: hysteria2Uri,
  hysteria: hysteriaUri,
  tuic: tuicUri,
  anytls: anytlsUri,
  socks: socksUri,
  http: httpUri
}

/** 已知无 URI 表示的类型，单独给提示而不是笼统报「不支持」 */
const NO_URI = {
  direct: '直连节点是本地虚拟节点，没有分享链接',
  wireguard: 'WireGuard 没有通用分享链接格式',
  ssh: 'SSH 出站没有通用分享链接格式',
  selector: '这不是一个真实节点',
  urltest: '这不是一个真实节点'
}

// -------------------------------------------------------------------- 入口

/**
 * 单个节点 → 分享链接。
 * @param {{name: string, kind?: string, outbound: object|null}} node store 里的节点记录
 * @returns {string}
 */
export function nodeToUri(node) {
  if (!node) throw new Error('节点不存在')
  if (node.kind === 'direct' || !node.outbound) {
    throw new Error(NO_URI.direct)
  }
  const o = node.outbound
  const type = String(o.type || '').toLowerCase()
  if (NO_URI[type]) throw new Error(NO_URI[type])

  const write = WRITERS[type]
  if (!write) throw new Error(`暂不支持导出 ${type} 类型的分享链接`)
  // 用户改过的显示名优先，它才是用户认得的那个名字
  return write(o, node.name || o.tag || `${o.server}:${o.server_port}`)
}

/**
 * 批量导出。跳不了的节点收集到 skipped 里，让调用方能如实告知用户。
 * @returns {{uris: string[], skipped: Array<{name: string, reason: string}>}}
 */
export function nodesToUris(nodes) {
  const uris = []
  const skipped = []
  for (const n of nodes || []) {
    try {
      uris.push(nodeToUri(n))
    } catch (e) {
      skipped.push({ name: n.name, reason: e.message })
    }
  }
  return { uris, skipped }
}

/** 订阅格式：整段链接列表的 base64，粘到别的客户端就能直接当订阅内容用 */
export function toSubscription(uris) {
  return b64encode(uris.join('\n'))
}
