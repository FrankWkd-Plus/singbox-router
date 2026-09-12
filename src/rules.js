/**
 * 自定义分流规则：一条规则 = 域名 / IP / 进程的任意组合 → 同一个去向
 *
 * 这里只做两件事：**校验**用户输入，和把规则**翻译**成 sing-box route 规则。
 * 规则的存储与顺序在 store.js，规则的插入位置在 config.js。
 *
 * 「一条规则内所有输入分到同一个流」的翻译方式：一条规则按匹配字段
 * 展开成若干条**连续**的 sing-box 规则（domain_suffix / domain_regex /
 * ip_cidr / process_name / process_path / process_path_regex），
 * 首个匹配生效 + 连续排放 ⇒ 语义上等价于「这些条件命中任意一个就走这个去向」。
 *
 * 正则支持情况（sing-box 侧的硬约束，不是本项目的取舍）：
 *
 * | 输入 | 正则 | 写法 | sing-box 字段 |
 * | --- | --- | --- | --- |
 * | 域名 | ✅ | `re:^.*\.cn$`（域名栏正则必须带 re: 前缀） | `domain_regex` |
 * | 进程 | ✅ | `re:^/usr/lib/firefox/` 或裸写 `^/usr/lib/firefox/`（自动识别） | `process_path_regex` |
 * | IP | ❌ | 只能写 CIDR / 裸 IP | `ip_cidr` |
 *
 * sing-box 的 IP 匹配走前缀树（radix trie），拿的是 32/128 位整数而不是
 * 字符串，没有可以跑正则的地方。所以 IP 栏填正则会被明确拒绝并给出
 * 替代建议，而不是默默存下来、等内核启动时报一句看不懂的错。
 */

/** 规则的去向：内置三选一，或某个节点的 id（面板下拉框用） */
export const RULE_TARGETS = {
  direct: '直连',
  proxy: '走代理',
  block: '拦截'
}

/**
 * Go RE2 不支持的构造。
 * JS 的 RegExp 能编译它们，内核不能 —— 不在这里拦下来，
 * 用户会得到「保存成功」然后内核起不来，排查起来极其难受。
 */
const RE2_UNSUPPORTED = [
  [/\(\?=/, '前向断言 (?=…)'],
  [/\(\?!/, '否定前向断言 (?!…)'],
  [/\(\?<=/, '后向断言 (?<=…)'],
  [/\(\?<!/, '否定后向断言 (?<!…)'],
  [/\(\?<[A-Za-z_]/, '命名分组 (?<name>…)，Go 的写法是 (?P<name>…)'],
  [/\\[1-9]/, '反向引用 \\1']
]

export function checkRegex(src) {
  // 借 JS 的引擎做语法体检，但 Go 的命名分组写作 (?P<name>…)，JS 只认 (?<name>…)。
  // 先翻译一下再编译，否则会把合法的 Go 写法误判成语法错误。
  // 下面的 RE2_UNSUPPORTED 仍然对原文匹配，所以 JS 式的 (?<name>…) 照旧会被拦。
  try {
    new RegExp(src.replace(/\(\?P</g, '(?<'))
  } catch (e) {
    return `正则语法错误：${e.message}`
  }
  for (const [re, what] of RE2_UNSUPPORTED) {
    if (re.test(src)) return `sing-box 用 Go RE2，不支持${what}`
  }
  return null
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isV4(s) {
  const m = V4.exec(s)
  return !!m && m.slice(1).every((x) => Number(x) <= 255 && (x === '0' || !x.startsWith('0')))
}

function isV6(s) {
  // 够用的粗校验：只允许十六进制段、冒号和内嵌 IPv4，且至多一个 ::
  if (!/^[0-9A-Fa-f:.]+$/.test(s)) return false
  if ((s.match(/::/g) || []).length > 1) return false
  const parts = s.split(':')
  if (parts.length > 8) return false
  return parts.every((p) => p === '' || /^[0-9A-Fa-f]{1,4}$/.test(p) || isV4(p))
}

/** 裸 IP 补上掩码 —— 用户写 198.51.100.7 显然是指这一个地址 */
export function normalizeCidr(raw) {
  const s = raw.trim()
  const slash = s.lastIndexOf('/')
  if (slash < 0) {
    if (isV4(s)) return { value: `${s}/32` }
    if (isV6(s)) return { value: `${s}/128` }
    return { error: `不是合法的 IP：${s}` }
  }
  const addr = s.slice(0, slash)
  const bits = Number(s.slice(slash + 1))
  const v4 = isV4(addr)
  if (!v4 && !isV6(addr)) return { error: `不是合法的 IP：${addr}` }
  const max = v4 ? 32 : 128
  if (!Number.isInteger(bits) || bits < 0 || bits > max) {
    return { error: `掩码位数应在 0–${max} 之间：${s}` }
  }
  return { value: `${addr}/${bits}` }
}

/** 多值输入：换行或逗号分隔。sing-box 的规则字段本身就收数组，天然对应。 */
export function splitValues(input) {
  if (Array.isArray(input)) input = input.join('\n')
  return String(input || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 域名与进程正则行的显式前缀。选 re: 是为了不和「/usr/bin 开头的进程路径」打架；
 *  进程栏另有自动识别（见 parseProcesses），re: 只在域名栏是必需的 */
const RE_PREFIX = /^re:(.*)$/

/** 域名栏：`re:` 前缀 → domain_regex；其余剥掉 URL 杂质后按后缀匹配（含所有子域名） */
function parseDomains(raw) {
  const suffix = []
  const regex = []
  for (const v of splitValues(raw)) {
    const m = RE_PREFIX.exec(v)
    if (m) {
      const err = checkRegex(m[1])
      if (err) return { error: `${v}：${err}` }
      regex.push(m[1])
      continue
    }
    // 顺手剥掉常见的整段粘贴残留，省得用户自己清
    let d = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '')
    d = d.replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '')
    if (!d) return { error: `不是合法的域名：${v}` }
    if (/\s/.test(d)) return { error: `域名里不能有空格：${v}` }
    if (!/^[0-9a-z.\-]+$/i.test(d)) {
      return { error: `不是合法的域名：${v}（含特殊字符；要按模式匹配请用 re: 前缀写正则）` }
    }
    suffix.push(d.toLowerCase())
  }
  return { suffix, regex }
}

/** IP 栏：只收 CIDR / 裸 IP。内核没有 IP 正则匹配器，糊过去只会换来启动失败 */
function parseIps(raw) {
  const out = []
  for (const v of splitValues(raw)) {
    if (RE_PREFIX.test(v)) {
      return {
        error:
          'sing-box 的 IP 匹配器只认 CIDR，没有 IP 正则。' +
          '想按网段分流请写 CIDR（如 198.51.100.0/24）；' +
          '想按模式分流请把这条写进「域名」栏用正则。'
      }
    }
    const r = normalizeCidr(v)
    if (r.error) return { error: r.error }
    out.push(r.value)
  }
  return { value: out }
}

/**
 * 进程栏：三种写法自动识别，不用记前缀 ——
 *   `re:` 前缀     → 显式声明这是路径正则
 *   含正则元字符    → 自动按路径正则处理（^ $ * + ? ( ) [ ] { } | \ 之外都是普通字符）
 *   其余以 / 开头   → 完整路径精确匹配
 *   其余            → 进程名精确匹配
 *
 * 「正则元字符」的判定故意保守：路径里合法出现的字符（字母数字 _ - . 空格等）
 * 都不算元字符，所以 /usr/bin/curl、/opt/brave.com/brave/brave、
 * /opt/wechat/wechat-4.0.0.30 这些带点的真实路径不会被误判；
 * 而 ^/usr/lib/firefox/、^.*telegram 这类一看就是正则的写法直接生效，
 * 用户不用学 re: 语法。光用 . 一个元字符的正则（如 wechat.helper）请加 re: 前缀。
 */
const REGEX_META = /[\\^$*+?()[\]{}|]/

function parseProcesses(raw) {
  const name = []
  const path = []
  const regex = []
  for (const v of splitValues(raw)) {
    const m = RE_PREFIX.exec(v)
    if (m) {
      const err = checkRegex(m[1])
      if (err) return { error: `${v}：${err}` }
      regex.push(m[1])
      continue
    }
    if (REGEX_META.test(v)) {
      // 按正则解释时整条就是模式（含开头的 /），/^\/usr/ 这种写法也成立
      const err = checkRegex(v)
      if (err) return { error: `${v}：${err}` }
      regex.push(v)
      continue
    }
    if (v.startsWith('/')) {
      if (/\s/.test(v)) return { error: `进程路径里不能有空格：${v}` }
      path.push(v)
    } else {
      if (/\s/.test(v)) return { error: `进程名里不能有空格：${v}` }
      name.push(v)
    }
  }
  return { name, path, regex }
}

/**
 * 校验并规范化一条规则。
 * @param {object} input 前端提交的原始对象（domain / ip / process 三个多值栏 + target）
 * @param {Array} nodes 现有节点，用于校验 target 指向的节点存在
 * @returns {{rule?: object, error?: string}}
 */
export function validateRule(input, nodes = []) {
  const domains = parseDomains(input.domain)
  if (domains.error) return { error: domains.error }

  const ips = parseIps(input.ip)
  if (ips.error) return { error: ips.error }

  const procs = parseProcesses(input.process)
  if (procs.error) return { error: procs.error }

  const empty =
    !domains.suffix.length &&
    !domains.regex.length &&
    !ips.value.length &&
    !procs.name.length &&
    !procs.path.length &&
    !procs.regex.length
  if (empty) return { error: '至少填一项匹配内容（域名 / IP / 进程）' }

  const target = String(input.target || '')
  if (!RULE_TARGETS[target] && !nodes.some((n) => n.id === target)) {
    return { error: `去向无效：${target}` }
  }

  const dedup = (arr) => [...new Set(arr)]
  return {
    rule: {
      domain: dedup(domains.suffix),
      domainRegex: dedup(domains.regex),
      ip: dedup(ips.value),
      process: dedup(procs.name),
      processPath: dedup(procs.path),
      processRegex: dedup(procs.regex),
      target,
      note: String(input.note || '').slice(0, 200),
      enabled: input.enabled !== false
    }
  }
}

/** 规则的去向 → sing-box 出站/动作 */
function resolveTarget(target, nodes) {
  if (target === 'direct') return { outbound: 'direct' }
  if (target === 'proxy') return { outbound: 'proxy' }
  // 1.12 起 block 出站废弃，改用规则动作
  if (target === 'block') return { action: 'reject' }
  const node = nodes.find((n) => n.id === target)
  if (!node) return null
  // 指向直连节点就是直连；指向代理节点走它自己的 tag
  return { outbound: node.kind === 'direct' ? 'direct' : node.tag }
}

/** 一条规则里非空的匹配字段，按固定顺序展开（同一条规则内顺序无所谓，去向相同） */
const FIELDS = [
  // 存储里的 domain 是 parseDomains 产出的「后缀值」——对应 domain_suffix（含子域名），
  // 不是 domain（仅精确匹配），别写反：写反了 www.github.com 会匹配不到 github.com 规则
  ['domain', 'domain_suffix'],
  ['domainRegex', 'domain_regex'],
  ['ip', 'ip_cidr'],
  ['process', 'process_name'],
  ['processPath', 'process_path'],
  ['processRegex', 'process_path_regex']
]

/**
 * 一条规则 → 一组连续的 sing-box route 规则（等价于「任一命中即走该去向」）。
 * 规则被禁用、内容为空、或目标节点已删时返回空数组。
 */
export function expandRule(rule, nodes) {
  if (!rule || rule.enabled === false) return []
  const target = resolveTarget(rule.target, nodes)
  if (!target) return []

  const out = []
  for (const [key, field] of FIELDS) {
    const values = (rule[key] || []).filter(Boolean)
    if (values.length) out.push({ [field]: values, ...target })
  }
  return out
}

/** 所有启用规则 → route 规则数组，顺序即优先级（首个匹配生效） */
export function toRouteRules(rules, nodes) {
  const out = []
  for (const r of rules || []) out.push(...expandRule(r, nodes))
  return out
}

/**
 * 规则里被引用的节点集合。
 * 面板用它提示「这个节点被分流规则引用，停用或删除后规则会失效」。
 * 出站本身对每个启用节点都会生成（不只是有独立端口的那些），
 * 所以这里不承担「给被引用节点补出站」的职责。
 */
export function referencedNodeIds(rules) {
  const ids = new Set()
  for (const r of rules || []) {
    if (r.enabled === false) continue
    if (!RULE_TARGETS[r.target]) ids.add(r.target)
  }
  return ids
}

/** 人类可读的一行摘要，面板列表和日志都用它 */
export function describeRule(rule, nodes = []) {
  const node = nodes.find((n) => n.id === rule.target)
  const to = RULE_TARGETS[rule.target] || (node ? node.name : '(节点已删除)')
  const parts = []
  if (rule.domain?.length) parts.push(`域名 ${rule.domain.join(' ')}${rule.domainRegex?.length ? ' 等正则' : ''}`)
  if (rule.domainRegex?.length) parts.push(`域名正则 ${rule.domainRegex.join(' ')}`)
  if (rule.ip?.length) parts.push(`IP ${rule.ip.join(' ')}`)
  if (rule.process?.length) parts.push(`进程 ${rule.process.join(' ')}`)
  if (rule.processPath?.length) parts.push(`路径 ${rule.processPath.join(' ')}`)
  if (rule.processRegex?.length) parts.push(`路径正则 ${rule.processRegex.join(' ')}`)
  return `${parts.join('，')} → ${to}`
}
