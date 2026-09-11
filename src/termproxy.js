/**
 * 终端代理接管
 *
 * 为什么这要单独做一件事：gsettings 那套「系统代理」只有图形程序读得到。
 * curl / git / npm / pip / docker build / apt 一律不认，它们只看 http_proxy
 * 这一类环境变量。所以「明明开了代理，终端里 git clone 还是卡死」是最常见的困惑，
 * 而它和节点、规则、TUN 全都无关。
 *
 * ★ 一个进程改不了另一个进程的环境变量 —— 这是内核层面的事实，没有绕过的办法。
 *   所以「接管」只能是两件事，面板把两件都做了：
 *     1. 往 shell 启动脚本里挂一段 source  → **以后新开的**终端自动带上代理
 *     2. 给出一行可以粘贴的命令            → **已经开着的**终端立刻生效
 *   任何声称能直接给已开终端上代理的做法都是假的，别信。
 *
 * 安全约定沿用 sysproxy.js 的思路：
 *   - 动用户的 .bashrc / .zshrc / config.fish 之前，先把原文备份到配置目录
 *   - 插入的内容夹在成对标记之间，取消接管时按标记整段摘掉，绝不动别的行
 *   - 只找到起始标记、没有结束标记时**什么都不做**（宁可留着让人工看，
 *     也不能从起始标记一路删到文件末尾）
 *   - 生成的片段默认带活性检查：内核没在跑时不设变量，否则每条 curl / apt
 *     都会变成「连接被拒绝」，比没有代理更难排查
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR, settings, DEFAULT_BYPASS } from './store.js'

/** 给 bash / zsh 用的片段 */
export const ENV_SH = path.join(DATA_DIR, 'proxy-env.sh')
/** 给 fish 用的片段（语法完全不同，只能各写一份） */
export const ENV_FISH = path.join(DATA_DIR, 'proxy-env.fish')

const BACKUP_DIR = path.join(DATA_DIR, 'shell-backup')
const RECORD = path.join(DATA_DIR, 'termproxy.json')

// 成对标记。fish 的注释也是 #，所以两种语法共用同一对标记。
const BEGIN = '# >>> singbox-router 终端代理 >>>'
const END = '# <<< singbox-router 终端代理 <<<'

const SHELLS = ['bash', 'zsh', 'fish']

// --------------------------------------------------------------------- 工具

function readFileOr(file, fallback = null) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

/** 原子写，并保留原文件权限位（rc 文件可能是 600，不该被我们放宽成 644） */
function atomicWrite(file, text) {
  let mode = 0o644
  try {
    mode = fs.statSync(file).mode & 0o777
  } catch {
    // 新建文件，用默认权限
  }
  const tmp = file + '.sbr-tmp'
  fs.writeFileSync(tmp, text, { mode })
  fs.renameSync(tmp, file)
}

/** 写进 rc 的路径尽量用 $HOME/… —— dotfiles 常被带到别的机器上 */
function homeShort(p) {
  const home = os.homedir()
  return p === home || p.startsWith(home + path.sep) ? '$HOME' + p.slice(home.length) : p
}

function zdotdir() {
  const z = process.env.ZDOTDIR
  return z && path.isAbsolute(z) ? z : os.homedir()
}

/** 我们认识的三种 shell 与它们的启动脚本 */
export function candidates() {
  const home = os.homedir()
  return [
    { shell: 'bash', rc: path.join(home, '.bashrc'), syntax: 'posix', snippet: ENV_SH },
    { shell: 'zsh', rc: path.join(zdotdir(), '.zshrc'), syntax: 'posix', snippet: ENV_SH },
    { shell: 'fish', rc: path.join(home, '.config', 'fish', 'config.fish'), syntax: 'fish', snippet: ENV_FISH }
  ]
}

/** 当前登录 shell。$SHELL 认不出来时按 bash 算 —— 装了 bash 的机器占绝大多数 */
export function loginShell() {
  const name = path.basename(String(process.env.SHELL || '')).trim()
  return SHELLS.includes(name) ? name : 'bash'
}

function proxyValues() {
  const s = settings()
  const bypass = Array.isArray(s.bypassList) && s.bypassList.length ? s.bypassList : DEFAULT_BYPASS.slice()
  return {
    host: '127.0.0.1',
    port: Number(s.mainPort),
    // no_proxy 的通配写法各工具支持程度不一（'*.local'、CIDR 只有部分工具认）。
    // 原样传过去：认的会用，不认的会忽略，不会因此报错。
    noProxy: bypass.join(',')
  }
}

function readRecord() {
  try {
    const r = JSON.parse(fs.readFileSync(RECORD, 'utf8'))
    return r && r.active ? r : null
  } catch {
    return null
  }
}

function writeRecord(rec) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(RECORD, JSON.stringify(rec, null, 2))
}

// ----------------------------------------------------------------- 片段内容

function posixSnippet() {
  const { host, port, noProxy } = proxyValues()
  return `# 由 singbox-router 生成 —— 请勿手改，每次接管 / 保存设置都会重写这个文件。
#
# 作用：让终端里的 curl / git / npm / pip / docker / apt 走本机代理。
# 系统设置里那个「网络代理」只有图形程序读得到，命令行工具一概不认，
# 它们只看 http_proxy 这一类环境变量 —— 所以需要这一份。
#
# 已经开着的终端不会自动生效（谁也改不了别的进程的环境变量），在里面执行一次：
#   source ${homeShort(ENV_SH)} && sbr_proxy_on
#
# 临时开关（只影响当前这个终端）：proxyon / proxyoff / proxystatus
#
# 想改开新终端时的默认行为，在挂载它的那一行**之前**设 SBR_PROXY_AUTO：
#   check （默认）端口上有人在听才设，内核没跑就不设
#   always        总是设
#   off           启动时不设，只把 proxyon / proxyoff 装好

SBR_PROXY_HOST="${host}"
SBR_PROXY_PORT="${port}"
SBR_PROXY_NO="${noProxy}"

sbr_proxy_on() {
  export http_proxy="http://$SBR_PROXY_HOST:$SBR_PROXY_PORT"
  export https_proxy="$http_proxy"
  # mixed 入站在同一个端口上同时提供 HTTP 和 SOCKS，所以这里指同一个端口。
  # socks5h 的 h 表示域名交给代理去解析，而不是本地先解析再连 —— 墙内环境要的是这个。
  export all_proxy="socks5h://$SBR_PROXY_HOST:$SBR_PROXY_PORT"
  export HTTP_PROXY="$http_proxy"
  export HTTPS_PROXY="$https_proxy"
  export ALL_PROXY="$all_proxy"
  export no_proxy="$SBR_PROXY_NO"
  export NO_PROXY="$SBR_PROXY_NO"
}

sbr_proxy_off() {
  unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY no_proxy NO_PROXY
}

sbr_proxy_status() {
  if [ -n "$http_proxy" ]; then
    printf '终端代理：开 -> %s（no_proxy=%s）\\n' "$http_proxy" "$no_proxy"
  else
    printf '终端代理：关（proxyon 可以打开）\\n'
  fi
}

# 端口上有没有人在听。内核没跑就别设变量 ——
# 那会让每条 curl / apt / git 变成「连接被拒绝」，比没有代理更难排查。
# 没有 ss 命令时不猜，直接当作可用。
sbr_proxy_alive() {
  command -v ss >/dev/null 2>&1 || return 0
  ss -ltn "sport = :$SBR_PROXY_PORT" 2>/dev/null | grep -q LISTEN
}

alias proxyon=sbr_proxy_on
alias proxyoff=sbr_proxy_off
alias proxystatus=sbr_proxy_status

case "\${SBR_PROXY_AUTO:-check}" in
  off) ;;
  always) sbr_proxy_on ;;
  *) sbr_proxy_alive && sbr_proxy_on ;;
esac
`
}

function fishSnippet() {
  const { host, port, noProxy } = proxyValues()
  return `# 由 singbox-router 生成 —— 请勿手改，每次接管 / 保存设置都会重写这个文件。
#
# 已经开着的终端不会自动生效，在里面执行一次：
#   source ${homeShort(ENV_FISH)}; and sbr_proxy_on
#
# 临时开关：proxyon / proxyoff / proxystatus
# 开新终端时的默认行为由 SBR_PROXY_AUTO 决定：check（默认）/ always / off

set -g SBR_PROXY_HOST ${host}
set -g SBR_PROXY_PORT ${port}
set -g SBR_PROXY_NO "${noProxy}"

function sbr_proxy_on -d '当前 fish 会话走本机代理'
    set -gx http_proxy "http://$SBR_PROXY_HOST:$SBR_PROXY_PORT"
    set -gx https_proxy $http_proxy
    # 同一个端口同时提供 HTTP 与 SOCKS；socks5h 表示域名交给代理解析
    set -gx all_proxy "socks5h://$SBR_PROXY_HOST:$SBR_PROXY_PORT"
    set -gx HTTP_PROXY $http_proxy
    set -gx HTTPS_PROXY $https_proxy
    set -gx ALL_PROXY $all_proxy
    set -gx no_proxy $SBR_PROXY_NO
    set -gx NO_PROXY $SBR_PROXY_NO
end

function sbr_proxy_off -d '取消当前 fish 会话的代理'
    set -e http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY no_proxy NO_PROXY
end

function sbr_proxy_status
    if set -q http_proxy
        printf '终端代理：开 -> %s\\n' $http_proxy
    else
        printf '终端代理：关（proxyon 可以打开）\\n'
    end
end

function sbr_proxy_alive
    if not command -q ss
        return 0
    end
    ss -ltn "sport = :$SBR_PROXY_PORT" 2>/dev/null | grep -q LISTEN
end

alias proxyon 'sbr_proxy_on'
alias proxyoff 'sbr_proxy_off'
alias proxystatus 'sbr_proxy_status'

switch "$SBR_PROXY_AUTO"
    case off
    case always
        sbr_proxy_on
    case '*'
        if sbr_proxy_alive
            sbr_proxy_on
        end
end
`
}

/**
 * 把两份片段写到配置目录。
 * 服务启动时和保存设置时都会调用，所以文件里的端口永远是最新的 ——
 * 面板给出的那行「粘到已开终端里」的命令因此总是有效。
 */
export function writeSnippets() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(ENV_SH, posixSnippet())
  fs.writeFileSync(ENV_FISH, fishSnippet())
  return { envSh: ENV_SH, envFish: ENV_FISH, ...proxyValues() }
}

// ------------------------------------------------------------- rc 文件读写

function hookBlock(syntax, snippet) {
  const p = homeShort(snippet)
  const note = '# 这一段由 singbox-router 面板维护：取消接管时会按标记整段摘掉。'
  const line = syntax === 'fish' ? `test -r "${p}"; and source "${p}"` : `if [ -r "${p}" ]; then . "${p}"; fi`
  return [BEGIN, note, line, END].join('\n')
}

/**
 * 摘掉我们插入的整段。
 * 只处理成对出现的标记 —— 结束标记被人删了的话原样留着并报告，
 * 绝不从起始标记一路删到文件末尾。
 */
function stripBlock(text) {
  let out = text
  let removed = 0
  for (;;) {
    const a = out.indexOf(BEGIN)
    if (a < 0) break
    const b = out.indexOf(END, a)
    if (b < 0) break
    let end = b + END.length
    if (out[end] === '\n') end++
    // 连同插入时加的那个空行一起收掉，免得反复接管 / 取消攒下一堆空行
    const start = a > 0 && out[a - 1] === '\n' ? a - 1 : a
    out = out.slice(0, start) + out.slice(end)
    removed++
  }
  return { text: out, removed, dangling: out.includes(BEGIN) }
}

function hook(t) {
  const existing = readFileOr(t.rc)
  const created = existing === null
  const text = existing ?? ''

  // 备份只留第一份 —— 那才是我们没动过的原文
  const backup = path.join(BACKUP_DIR, path.basename(t.rc) + '.bak')
  if (!created && !fs.existsSync(backup)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    fs.writeFileSync(backup, text)
  }

  let next = stripBlock(text).text
  if (next && !next.endsWith('\n')) next += '\n'
  next += '\n' + hookBlock(t.syntax, t.snippet) + '\n'

  fs.mkdirSync(path.dirname(t.rc), { recursive: true })
  atomicWrite(t.rc, next)
  return { shell: t.shell, rc: t.rc, created, backup: created ? null : backup }
}

/**
 * 挂到哪几个 rc 上：已经存在的那些，加上当前登录 shell 的那一份（没有就建）。
 * 不给不用 fish 的人凭空造一个 config.fish。
 */
function pickTargets(only) {
  const all = candidates()
  if (Array.isArray(only) && only.length) {
    const want = all.filter((c) => only.includes(c.shell))
    if (want.length) return want
  }
  const login = loginShell()
  const picked = all.filter((c) => fs.existsSync(c.rc) || c.shell === login)
  return picked.length ? picked : all.filter((c) => c.shell === login)
}

// ------------------------------------------------------------------- 对外

/** 已开着的终端要粘的那一行（source 之后显式调函数：别名在同一行里还没生效） */
export function sourceLine(shell = loginShell()) {
  return shell === 'fish'
    ? `source ${ENV_FISH}; and sbr_proxy_on`
    : `source ${ENV_SH} && sbr_proxy_on`
}

/** 磁盘上的片段是否还对得上当前端口（面板离线期间改过端口就会对不上） */
function snippetFresh() {
  const { port } = proxyValues()
  const sh = readFileOr(ENV_SH)
  return !!sh && sh.includes(`SBR_PROXY_PORT="${port}"`)
}

/**
 * 当前状态。**以 rc 文件里有没有标记为准**，不信我们自己记的账 ——
 * 用户完全可能手动把那段删掉，那时就该显示「未接管」。
 */
export function state() {
  const { host, port, noProxy } = proxyValues()
  const shells = candidates().map((c) => {
    const text = readFileOr(c.rc)
    return {
      shell: c.shell,
      rc: c.rc,
      exists: text !== null,
      hooked: typeof text === 'string' && text.includes(BEGIN),
      dangling: typeof text === 'string' && text.includes(BEGIN) && !text.includes(END)
    }
  })
  const rec = readRecord()
  return {
    managed: shells.some((x) => x.hooked),
    host,
    port,
    noProxy,
    shells,
    loginShell: loginShell(),
    envSh: ENV_SH,
    envFish: ENV_FISH,
    sourceLine: sourceLine(),
    snippetFresh: snippetFresh(),
    since: rec ? rec.at : null
  }
}

/**
 * 接管：写片段 + 往 rc 里挂 source。
 * @param {{shells?: string[]}} opts 只想挂某几个 shell 时传，默认自动挑
 */
export function apply(opts = {}) {
  writeSnippets()

  const applied = []
  const failed = []
  for (const t of pickTargets(opts.shells)) {
    try {
      applied.push(hook(t))
    } catch (e) {
      failed.push({ shell: t.shell, rc: t.rc, error: e.message })
    }
  }
  if (!applied.length) {
    throw new Error(
      '没有能写入的 shell 启动脚本：' +
        (failed.map((f) => `${f.rc}（${f.error}）`).join('、') || '一个都没找到')
    )
  }

  writeRecord({ active: true, at: Date.now(), port: proxyValues().port, targets: applied.map((a) => a.rc) })
  return { ok: true, ...state(), applied, failed }
}

/** 取消接管：把所有 rc 里我们那段摘掉。片段文件保留（还能手动 source）。 */
export function restore() {
  const reverted = []
  for (const t of candidates()) {
    const text = readFileOr(t.rc)
    if (text === null) continue
    const r = stripBlock(text)
    if (!r.removed) {
      if (r.dangling) {
        reverted.push({
          shell: t.shell,
          rc: t.rc,
          removed: 0,
          warn: '只找到起始标记、没找到结束标记，没敢动。请打开这个文件手动删掉那一段。'
        })
      }
      continue
    }
    let next = r.text
    if (next && !next.endsWith('\n')) next += '\n'
    atomicWrite(t.rc, next)
    reverted.push({ shell: t.shell, rc: t.rc, removed: r.removed })
  }
  writeRecord({ active: false, at: Date.now() })
  return { ok: true, ...state(), reverted }
}

/**
 * 端口 / 绕过列表变了之后重新生成片段（不碰 rc 文件）。
 * rc 里挂的是 source 那个固定路径，所以只要片段是新的，新开的终端就是对的。
 */
export function sync() {
  writeSnippets()
  return { ok: true, ...proxyValues() }
}
