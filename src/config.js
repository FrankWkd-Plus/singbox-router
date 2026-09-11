/**
 * 生成 sing-box 配置（schema 对齐 sing-box 1.12+）
 *
 * 分流机制：
 *   - 主端口 (mainPort) / TUN → 依次过：自定义规则 → 私有地址 → proxy 选择器
 *   - 每节点独立端口          → 在 route.rules 里用 inbound 直绑该节点出站
 *   - 虚拟【直连】节点端口    → 直绑内置 direct 出站，任何模式下都是直连
 *
 * ★ 规则优先级（sing-box 路由「首个匹配生效」，顺序即语义）：
 *   1. sniff / hijack-dns        协议层，必须最前
 *   2. 节点独立端口直绑          用户在端口上写死的意图，最高优先级
 *   3. clash_mode direct/global  全局模式开关，只影响没被直绑的流量
 *   4. 自定义规则                进程 / IP / 域名，用户显式写的，从上到下
 *   5. 私有地址与内网域名        安全兜底
 *   6. 国内自动分流（可选）      最宽泛的「猜」，所以排最后
 *   7. final: proxy
 *
 *   2 在 3 之前是核心不变量：独立端口是用户显式指定的「这个端口固定走这个节点」，
 *   不该被全局/直连模式的下拉框静默推翻。4 在 5 之前也是显式压兜底。
 *
 * 默认不引用 geo 规则集（无启动期下载依赖）；只有设置里开了「国内自动分流」
 * 才引用 geosite-cn / geoip-cn，且默认用本地已下好的 .srs（见 ruleset.js）。
 * 私有地址/域名始终用内置的 domain_suffix 与 ip_is_private 判断。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getState, DATA_DIR } from './store.js'
import { toRouteRules, referencedNodeIds, RULE_TARGETS, describeRule } from './rules.js'
import { buildRuleSets, effectiveSource, status as rulesetStatus } from './ruleset.js'

export const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

/** 内网/保留域名，不依赖任何下载 */
const PRIVATE_SUFFIXES = [
  '.local',
  '.localdomain',
  '.localhost',
  '.lan',
  '.home.arpa',
  '.internal',
  '.test',
  '.invalid',
  '.example'
]

/** 节点专属入站的 tag */
export function inboundTag(node) {
  return 'in-' + node.id
}

/** 虚拟直连节点：没有自己的出站，直接绑内置 direct */
export function isDirectNode(node) {
  return node.kind === 'direct'
}

/** 该节点的流量最终走哪个出站 */
export function outboundFor(node) {
  return isDirectNode(node) ? 'direct' : node.tag
}

export function buildConfig() {
  const st = getState()
  const s = st.settings
  // 虚拟直连节点没有 outbound 对象，真实节点必须有
  const nodes = st.nodes.filter((n) => n.enabled && (isDirectNode(n) || (n.outbound && n.outbound.type)))
  const listen = s.allowLan ? '0.0.0.0' : '127.0.0.1'

  // ------------------------------------------------------------- inbounds
  const inbounds = [{ type: 'mixed', tag: 'in-main', listen, listen_port: Number(s.mainPort) }]

  // TUN 全局透明代理：捕获所有不认系统代理的程序（Telegram、CLI 工具等）
  if (s.tunEnabled) {
    inbounds.push({
      type: 'tun',
      tag: 'in-tun',
      interface_name: s.tunInterface || 'sbr-tun',
      address: [s.tunAddress || '172.19.0.1/30'],
      mtu: Number(s.tunMTU) || 9000,
      auto_route: true,
      strict_route: s.tunStrictRoute !== false,
      stack: s.tunStack || 'mixed',
      // 用非默认索引，避免和其它 sing-box 客户端（v2rayN 用默认 2022/9000）抢同一张表
      iproute2_table_index: Number(s.tunTableIndex) || 2023,
      iproute2_rule_index: Number(s.tunRuleIndex) || 9100
    })
  }

  const perNode = nodes.filter((n) => Number(n.port) > 0)
  for (const n of perNode) {
    inbounds.push({ type: 'mixed', tag: inboundTag(n), listen, listen_port: Number(n.port) })
  }

  // ------------------------------------------------------------ outbounds
  const proxyNodes = nodes.filter((n) => !isDirectNode(n))
  const nodeOutbounds = proxyNodes.map((n) => ({ ...n.outbound, tag: n.tag }))
  const tags = nodeOutbounds.map((o) => o.tag)

  const outbounds = []
  if (tags.length) {
    outbounds.push({
      type: 'selector',
      tag: 'proxy',
      // 把 direct 也放进选择器，主端口可以整体切直连
      outbounds: ['auto', ...tags, 'direct'],
      default: 'auto',
      interrupt_exist_connections: false
    })
    outbounds.push({
      type: 'urltest',
      tag: 'auto',
      outbounds: tags,
      url: s.testUrl,
      interval: '3m',
      tolerance: 150
    })
  } else {
    // 还没有真实节点时也要能起内核，proxy 退化为直连
    outbounds.push({ type: 'selector', tag: 'proxy', outbounds: ['direct'], default: 'direct' })
  }
  outbounds.push(...nodeOutbounds)
  outbounds.push({ type: 'direct', tag: 'direct' })

  // ---------------------------------------------------------- route rules
  const rules = []

  // TUN 收到的是裸 IP 包，不嗅探则拿不到域名（日志与 DNS 行为都会变差）
  const sniffInbounds = ['in-main']
  if (s.tunEnabled) sniffInbounds.push('in-tun')
  rules.push({ inbound: sniffInbounds, action: 'sniff' })
  rules.push({ protocol: 'dns', action: 'hijack-dns' })
  // TUN 下再按端口兜一层：protocol:dns 依赖嗅探结果，port:53 是确定性的
  if (s.tunEnabled) rules.push({ port: 53, action: 'hijack-dns' })

  // ★ 节点独立端口直绑 —— 分流的核心。
  // 必须排在 clash_mode 之前：独立端口是用户显式指定的「这个端口固定走这个节点」，
  // 不该被全局/直连模式的下拉框静默推翻（模式开关只应影响全局流量）。
  for (const n of perNode) {
    rules.push({ inbound: [inboundTag(n)], outbound: outboundFor(n) })
  }

  // Clash 模式开关：只对没被上面直绑走的流量（主端口 / TUN）生效
  rules.push({ clash_mode: 'direct', outbound: 'direct' })
  rules.push({ clash_mode: 'global', outbound: 'proxy' })

  // ★ 自定义分流规则（进程 / IP / 域名）—— 用户显式写的，排在通用兜底之前。
  // 规则数组顺序即优先级（首个匹配生效），面板里的上下移动改的就是这个顺序。
  // 指向已禁用或已删除节点的规则会被 toRouteRules 丢掉，
  // 绝不会生成一条指向不存在 tag 的规则（那会让内核直接拒绝启动）。
  rules.push(...toRouteRules(st.rules, nodes))

  // 私有地址/域名直连，用内置判断，不依赖规则集下载
  rules.push({ domain_suffix: PRIVATE_SUFFIXES, outbound: 'direct' })
  rules.push({ ip_is_private: true, outbound: 'direct' })

  // 国内自动分流：最宽泛的一层猜测，所以排在所有显式规则之后
  const geo = s.chinaDirect ? buildRuleSets() : null
  if (geo) {
    // 域名侧靠 geosite-cn，命中即直连 —— 不需要先解析成 IP
    rules.push({ rule_set: ['geosite-cn'], outbound: 'direct' })
    // IP 侧靠 geoip-cn。没有插入 action:'resolve'，所以它匹配的是
    // 「目标本来就是 IP」的连接（大量 App 直连 IP）以及嗅探已知 IP 的情况；
    // 域名类流量由上一条负责。刻意不做全局 resolve：那会给每条代理连接
    // 都加一次本地解析，既慢又容易把本该整域名交给代理的连接降级成 IP 连接。
    rules.push({ rule_set: ['geoip-cn'], outbound: 'direct' })
  }

  // ------------------------------------------------------------------ DNS
  const dns = {
    servers: [
      // 国内 DNS 直连走 UDP，快。direct 出站解析域名也用它。
      { tag: 'dns-local', type: 'udp', server: s.dnsLocal || '223.5.5.5' },
      // 国外 DNS 走 DoT(TCP/853)而不是 UDP：UDP DNS 穿代理依赖出站的 UDP 转发能力，
      // 很多节点上会超时或丢包，表现就是「能连但解析不了域名」。DoT 基于 TCP，任何代理都能稳定承载。
      { tag: 'dns-remote', type: 'tls', server: s.dnsRemote || '8.8.8.8', server_port: 853, detour: 'proxy' }
    ],
    rules: [
      { clash_mode: 'direct', server: 'dns-local' },
      { clash_mode: 'global', server: 'dns-remote' },
      { domain_suffix: PRIVATE_SUFFIXES, server: 'dns-local' }
    ],
    final: 'dns-remote',
    strategy: 'prefer_ipv4',
    independent_cache: true
  }

  // 开了国内直连，国内域名就该用国内 DNS 解析：
  // 一是快、拿到的是就近 CDN 节点，二是让 geoip-cn 那条规则真的能命中中国 IP
  if (geo) dns.rules.push({ rule_set: ['geosite-cn'], server: 'dns-local' })

  const route = {
    rules,
    auto_detect_interface: true,
    default_domain_resolver: { server: 'dns-local' },
    final: 'proxy'
  }
  if (geo) route.rule_set = geo.ruleSets

  return {
    log: { level: s.logLevel || 'info', timestamp: true },
    dns,
    inbounds,
    outbounds,
    route,
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${s.clashApiPort}`,
        secret: s.clashSecret,
        default_mode: 'rule'
      },
      cache_file: { enabled: true, path: 'cache.db', store_rdrc: true }
    }
  }
}

/** 落盘，返回配置文件路径 */
export function writeConfig() {
  const cfg = buildConfig()
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  return CONFIG_FILE
}

/** 启动前自检：返回人类可读的问题列表 */
export function validate() {
  const st = getState()
  const s = st.settings
  const issues = []

  const seen = new Map()
  const claim = (port, who) => {
    const p = Number(port)
    if (!p) return
    if (seen.has(p)) issues.push(`端口 ${p} 被重复占用：${seen.get(p)} 与 ${who}`)
    else seen.set(p, who)
  }

  claim(s.webPort, 'Web 面板')
  claim(s.mainPort, '主代理端口')
  claim(s.clashApiPort, 'Clash API')
  for (const n of st.nodes) {
    if (n.enabled && Number(n.port) > 0) claim(n.port, `节点「${n.name}」`)
  }

  const real = st.nodes.filter((n) => n.enabled && !isDirectNode(n))
  if (!real.length) issues.push('没有已启用的代理节点，全局流量将直连')

  // 自定义规则指向的节点必须存在且启用，否则这条规则会被静默丢掉 ——
  // 静默是最糟的失败方式，宁可在启动前说清楚
  const usable = new Set(st.nodes.filter((n) => n.enabled).map((n) => n.id))
  for (const r of st.rules || []) {
    if (r.enabled === false) continue
    if (RULE_TARGETS[r.target] || usable.has(r.target)) continue
    const node = st.nodes.find((n) => n.id === r.target)
    issues.push(
      `分流规则「${describeRule(r, st.nodes)}」指向的节点${node ? '已禁用' : '已删除'}，该规则不会生效`
    )
  }

  // 国内自动分流：本地模式缺文件就是起不来，得当场说明怎么补
  if (s.chinaDirect && effectiveSource() === 'local') {
    const missing = rulesetStatus().filter((x) => !x.present)
    if (missing.length) {
      issues.push(
        `国内自动分流缺少规则集：${missing.map((m) => m.file).join('、')}。` +
          `在「设置 → 国内自动分流」里点「下载 / 更新规则集」补齐`
      )
    }
  }

  return issues
}

/** 供面板展示：规则引用了哪些节点（用于提示“这个节点被规则引用，删了会失效”） */
export function ruleReferencedNodes() {
  return referencedNodeIds(getState().rules)
}
