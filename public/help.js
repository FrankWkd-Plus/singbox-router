/**
 * 【?】图标：文案 + 气泡
 *
 * 每条 HELP 记录 = 面板上一个可点的问号：
 *   t 标题 · d 一句话说清「是什么 / 为什么这样设」· a wiki.html 里的锚点
 *
 * 文案里的 `反引号` 渲染成 <code>，用 DOM 拼，不走 innerHTML。
 * key 由 index.html 的 data-help="key" 引用；a 必须能在 wiki.html 里找到同名 id。
 *
 * 这个模块刻意不 import app.js —— app.js 顶层有 await 和副作用，
 * 互相 import 会成环。所以这里自带一个极小的 DOM 构建器。
 */

export const HELP = {
  // ------------------------------------------------------------------ 顶栏
  'proxy-select': {
    t: '主端口所用节点',
    d: '决定主端口和 TUN 的流量从哪个节点出去。`自动选择` 走 urltest 按延迟挑最快的，也可以钉死某个节点。改动立刻生效，不需要重启内核。注意它管不到节点的独立端口 —— 那些端口是直绑的。',
    a: 'mode'
  },
  'mode-select': {
    t: '分流模式',
    d: '`规则分流` 私有地址直连、其余走所选节点；`全局代理` 一律走代理；`全局直连` 一律不走代理。三个模式都只影响主端口与 TUN，**压不过节点的独立端口绑定**。',
    a: 'mode'
  },
  'core-start': {
    t: '启动内核',
    d: '写出配置并拉起 sing-box。启动前会查端口占用；开了 TUN 还要过权限、冲突、残留三道检查，任一不满足就拦下并给出具体修复命令 —— TUN 配错会导致整机断网，宁可不启动。',
    a: 'tun-checks'
  },
  'core-apply': {
    t: '应用配置',
    d: '把当前的设置和节点重新生成配置并重启内核。改了设置、端口、节点开关之后顶栏会出现 `配置已变更`，点这里才真正生效。内核没运行时只写配置文件，不启动。',
    a: 'quickstart'
  },
  'sysproxy-btn': {
    t: '接管 / 还原系统代理',
    d: '把系统的 http/https/socks 三项都指向主端口，走 `gsettings`。改之前会把原值备份到磁盘，内核意外退出时自动还原，不会把机器留在「代理指向死端口」的断网状态。',
    a: 'sysproxy'
  },

  // ------------------------------------------------------------------ 节点
  'add-direct': {
    t: '+ 直连节点',
    d: '加一个虚拟【直连】节点：没有远端服务器，只占一个本地端口，**走这个端口的流量在任何模式下都直连**。用来给个别程序开后门，比按域名猜的国内直连规则精确得多。',
    a: 'direct-node'
  },
  'test-all': {
    t: '全部测速',
    d: '经 Clash API 逐个测节点延迟，**需要内核正在运行**。测的是设置里的「测速地址」，默认 `generate_204`。虚拟直连节点不参与 —— 测它没有意义。',
    a: 'nodes'
  },
  reassign: {
    t: '重排端口',
    d: '从「节点端口起始值」开始，给所有节点重新连续分配独立端口。删过节点后端口会留空洞，用这个整理。注意：已经配好 `http.proxy` 的程序会指到别的节点上去。',
    a: 'node-port'
  },
  'node-port-col': {
    t: '独立端口',
    d: '每个节点可以绑一个本地端口，程序指向它，流量就固定从这个节点出去。填 `0` 表示不分配。端口是 `mixed` 入站，HTTP 和 SOCKS5 共用同一个端口号。',
    a: 'node-port'
  },
  'node-delay-col': {
    t: '延迟',
    d: '经 Clash API 实测的握手延迟，绿 < 300ms、黄 < 800ms、红更慢。要内核在跑才能测。这个值也是 `自动选择` 挑节点的依据。',
    a: 'nodes'
  },

  // -------------------------------------------------------------- 订阅 / 导入
  'subs-card': {
    t: '订阅',
    d: '按 UA 拉取，默认 `clash.meta/1.19.0`（拿 Clash YAML 兼容性最好）；拿不到节点时换 `sing-box` 或 `v2rayN` 重试。更新是增量的：消失的节点被移除，仍在的**保留你分配的端口和开关**。',
    a: 'subs'
  },
  'sub-add': {
    t: '添加并拉取',
    d: '存下订阅并立刻拉一次。面板会显示解析出的节点数、识别到的格式，以及机场返回的流量与到期信息（`Subscription-Userinfo` 响应头）。',
    a: 'subs'
  },
  'import-card': {
    t: '粘贴导入',
    d: '自动识别订阅 base64、各协议分享链接（可多行混合）、Clash/mihomo YAML、sing-box JSON、单个 JS 对象字面量。解析走 proxy-utils 和内置解析器两条通路，互为兜底。',
    a: 'import'
  },

  // ------------------------------------------------------------ 设置 · 端口
  'set-ports': {
    t: '端口',
    d: '三个端口都会在启动前查系统占用，被占了会明确报出是哪个端口、被谁占用。改完记得点「保存设置」再「应用配置」。',
    a: 'set-ports'
  },
  mainPort: {
    t: '主代理端口',
    d: '默认 `7890`。系统代理接管指向的就是它，TUN 之外的全局流量也从这里进，走「主端口所用节点」。这是一个 `mixed` 入站，HTTP 与 SOCKS5 同端口。',
    a: 'set-ports'
  },
  portBase: {
    t: '节点端口起始值',
    d: '默认 `20800`。给节点自动分配独立端口时从这个值开始递增。改完点「重排端口」才会重新排布已有节点。',
    a: 'node-port'
  },
  clashApiPort: {
    t: 'Clash API 端口',
    d: '默认 `19090`。内核的外部控制接口，面板用它做延迟测试、读写分流模式、切换选择器节点。只监听回环，带随机 secret。',
    a: 'set-ports'
  },

  // ------------------------------------------------------------ 设置 · 网络
  'set-network': {
    t: '网络',
    d: '不做自动分流：主端口与 TUN 的流量全部走所选节点，只有私有地址和 `.local` 这类内网域名内置直连。要让某些流量直连，用【直连】节点。',
    a: 'set-network'
  },
  allowLan: {
    t: '允许局域网连接',
    d: '打开后所有代理入站从 `127.0.0.1` 改为监听 `0.0.0.0`，同一局域网的手机、电视盒都能用。**面板本身仍然只监听回环**，但代理端口就此暴露给整个局域网，不在可信网络里别开。',
    a: 'set-network'
  },
  dnsLocal: {
    t: '国内 DNS（直连解析用）',
    d: '默认 `223.5.5.5`，走 UDP 直连，快。`direct` 出站解析域名、私有域名解析都用它。',
    a: 'tun-dns'
  },
  dnsRemote: {
    t: '国外 DNS（经代理，DoT/853）',
    d: '默认 `8.8.8.8`，走 **DoT（TLS/853）经代理出站**，不用 UDP。UDP DNS 穿代理依赖节点的 UDP 转发能力，很多节点会超时丢包 —— 表现就是「网页能连但域名解析不了」。DoT 基于 TCP，任何代理都能稳定承载。',
    a: 'tun-dns'
  },

  // ------------------------------------------------------------- 设置 · TUN
  'set-tun': {
    t: 'TUN 全局代理',
    d: '建一块虚拟网卡透明捕获**所有**程序的流量，包括不认系统代理的 Telegram 和 CLI 工具。需要内核具备 `CAP_NET_ADMIN`：跑一次 `bash scripts/setup-tun.sh`，之后启停都免密码。',
    a: 'tun'
  },
  tunEnabled: {
    t: '启用 TUN 全局代理',
    d: '勾选后要点「应用配置」再「启动」才生效。开 TUN 时会自动跳过系统代理接管 —— 已经全局捕获了，再叠一层只会让人误判问题出在哪。与 v2rayA / v2rayN / Clash 的全局模式不能同时开。',
    a: 'tun'
  },
  tunStrictRoute: {
    t: '严格路由（strict_route）',
    d: '默认开。让内核用更强的策略路由把流量按死在 TUN 里，防止程序绑定物理网卡绕过代理。极少数场景（虚拟机桥接、容器网络）下会干扰局域网互通，那时才关。',
    a: 'set-tun'
  },
  tunInterface: {
    t: '网卡名',
    d: '默认 `sbr-tun`。刻意不用 sing-box 默认的 `singbox_tun` —— v2rayN 等客户端用的正是那个名字，错开后残留清理只认我们自己的网卡，绝不会拆掉别人正在工作的 TUN。',
    a: 'tun-route-index'
  },
  tunAddress: {
    t: '网卡地址',
    d: '默认 `172.19.0.1/30`，虚拟网卡自己的地址段。只在和现有内网网段撞了的时候才需要改。',
    a: 'set-tun'
  },
  tunMTU: {
    t: 'MTU',
    d: '默认 `9000`。大 MTU 减少分包、提高吞吐。个别链路下大包会被丢，出现「能连但传大文件卡死」时降到 `1500` 试试。',
    a: 'set-tun'
  },
  tunStack: {
    t: '网络栈',
    d: '`mixed` 推荐：TCP 走系统栈（快），UDP 走 gvisor（稳）。`system` 全交给内核栈，性能最好但兼容性差些；`gvisor` 全用用户态栈，最兼容但吞吐低。',
    a: 'set-tun'
  },

  // -------------------------------------------------------- 设置 · 系统代理
  'set-sysproxy': {
    t: '系统代理',
    d: 'Linux 桌面走 `gsettings`（Cinnamon / GNOME / MATE / Xfce）。它只影响「主动读取系统代理」的图形程序，命令行工具要 `source data/proxy-env.sh`。',
    a: 'sysproxy'
  },
  autoSetSystemProxy: {
    t: '自动接管 / 还原',
    d: '默认开：内核启动时接管系统代理，停止时还原。原值会先原样备份到磁盘（`data/sysproxy-backup.json`），面板下次启动时若发现残留备份会自动还原 —— 上次异常退出也救得回来。',
    a: 'sysproxy'
  },
  bypassList: {
    t: '绕过列表',
    d: '这些地址不走系统代理，逗号或换行分隔。默认含 `localhost`、`127.0.0.0/8`、三段私有网段和 `*.local`。只作用于系统代理，不影响 sing-box 自己的路由规则。',
    a: 'set-sysproxy'
  },

  // ------------------------------------------------------------ 设置 · 其他
  'set-misc': {
    t: '其他',
    d: '测速、日志、内核路径和两个自动化开关。改完点「保存设置」；涉及配置生成的项还要点「应用配置」。',
    a: 'set-misc'
  },
  testUrl: {
    t: '测速地址',
    d: '默认 `https://www.gstatic.com/generate_204`。节点延迟测试和 `auto` 选择器的判据都用它。换成国内可达的地址会让所有节点看起来都很快，失去比较意义。',
    a: 'set-misc'
  },
  testTimeout: {
    t: '测速超时 (ms)',
    d: '默认 `5000`。超过这个时间没握手成功就算失败，延迟显示为 `—`。节点多的时候调小可以让「全部测速」快一些。',
    a: 'set-misc'
  },
  logLevel: {
    t: '日志级别',
    d: '`trace` / `debug` / `info` / `warn` / `error`，默认 `info`。查连接细节时调到 `debug`，日志会明显变多。在「日志」标签页实时看。',
    a: 'set-misc'
  },
  corePath: {
    t: '内核路径',
    d: '留空则自动探测：先找项目里的 `./bin/sing-box`，再找 `PATH`。填绝对路径可以复用系统上已有的 sing-box。需要 **1.12+**，配置用的是新版 DNS 与 `action` 字段的 schema。',
    a: 'install'
  },
  autoAssignPorts: {
    t: '导入时自动分配独立端口',
    d: '默认开：新导入的节点自动从「节点端口起始值」往后拿一个空闲端口。关掉的话新节点端口为 `0`，只能走主端口，要用独立端口得手填。',
    a: 'node-port'
  },
  autoStartCore: {
    t: '开机自启内核',
    d: '默认关。面板服务开机自启是装桌面应用时就配好的，但**内核默认要你自己点启动** —— 开机瞬间网络未必就绪，若有别的全局代理在跑 TUN 还会被前置检查拦下，自动启动只会让人一头雾水。',
    a: 'desktop-autostart'
  },

  // -------------------------------------------------------- 设置 · 底部按钮
  'save-settings': {
    t: '保存设置',
    d: '只写入设置文件，**不会立刻改变正在运行的内核**。端口、DNS、TUN 这些进配置的项，保存后还要点顶栏「应用配置」重启内核才生效。',
    a: 'quickstart'
  },
  'view-config': {
    t: '查看生成的配置',
    d: '预览当前设置和节点会生成的 sing-box 配置 JSON。排查分流问题时最有用：可以直接确认节点直绑规则是不是排在 `clash_mode` 之前。',
    a: 'routing'
  }
}

// --------------------------------------------------------------------- 渲染

/** 极小 DOM 构建器（本模块自用，避免与 app.js 互相 import 成环） */
function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v)
    else node.setAttribute(k, String(v))
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid)
  return node
}

/** `反引号` → <code>，**星号** → <b>。纯文本拼 DOM，不用 innerHTML。 */
function richText(text) {
  const frag = document.createDocumentFragment()
  text.split('`').forEach((chunk, i) => {
    if (!chunk) return
    if (i % 2) {
      frag.append(h('code', { text: chunk }))
      return
    }
    chunk.split('**').forEach((part, j) => {
      if (!part) return
      frag.append(j % 2 ? h('b', { text: part }) : document.createTextNode(part))
    })
  })
  return frag
}

// ------------------------------------------------------------------ 气泡

let pop = null
let current = null

function closePop() {
  if (!pop) return
  pop.hidden = true
  if (current) current.classList.remove('open')
  current = null
}

/** 贴着图标放，撞到视口边缘就往里收 */
function place(icon) {
  const r = icon.getBoundingClientRect()
  const pad = 10
  pop.style.visibility = 'hidden'
  pop.hidden = false
  const w = pop.offsetWidth
  const hgt = pop.offsetHeight

  let left = r.left + r.width / 2 - w / 2
  left = Math.min(Math.max(pad, left), Math.max(pad, window.innerWidth - w - pad))

  // 下面放不下就翻到上面
  let top = r.bottom + 8
  if (top + hgt > window.innerHeight - pad && r.top - hgt - 8 > pad) top = r.top - hgt - 8

  pop.style.left = left + 'px'
  pop.style.top = top + 'px'
  pop.style.visibility = 'visible'
}

/**
 * 给所有 [data-help] 图标绑气泡。
 * @param {(anchor: string) => void} openWiki 点「查看完整文档」时的跳转回调
 */
export function initHelp(openWiki) {
  const title = h('b', { class: 'help-pop-title' })
  const body = h('p', { class: 'help-pop-body' })
  const more = h('button', { class: 'mini help-pop-more', type: 'button', text: '查看完整文档 →' })
  pop = h('div', { class: 'help-pop', role: 'dialog', hidden: '' }, title, body, more)
  document.body.append(pop)

  let anchor = 'overview'
  more.addEventListener('click', () => {
    closePop()
    openWiki(anchor)
  })

  for (const icon of document.querySelectorAll('[data-help]')) {
    const topic = HELP[icon.dataset.help]
    if (!topic) {
      // 文案没写就别留一个点了没反应的问号
      icon.remove()
      continue
    }
    icon.setAttribute('aria-label', '说明：' + topic.t)
    icon.title = topic.t
    icon.addEventListener('click', (ev) => {
      // 图标常常嵌在 <label> 里，不阻止的话会顺手把复选框也切了
      ev.preventDefault()
      ev.stopPropagation()

      if (current === icon) {
        closePop()
        return
      }
      closePop()
      title.textContent = topic.t
      body.replaceChildren(richText(topic.d))
      anchor = topic.a || 'overview'
      current = icon
      icon.classList.add('open')
      place(icon)
    })
  }

  document.addEventListener('click', (ev) => {
    if (current && !pop.contains(ev.target)) closePop()
  })
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closePop()
  })
  // 页面一滚气泡就飘了，索引重算不如直接关掉
  window.addEventListener('scroll', closePop, true)
  window.addEventListener('resize', closePop)
}
