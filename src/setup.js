/**
 * 安装与授权 —— 原先散在 scripts/*.sh 里的活，全部搬进程序内部。
 *
 * 面板和托盘现在都能直接调用这些函数，用户不需要开终端敲 bash。
 *
 * 三类活分开处理：
 *   1. 纯下载（内核）—— 用 fetch + zlib，全程在内存里，不落临时目录，
 *      于是也不需要事后清理（本项目约定不用 rm）。
 *   2. 必须 root 的（setcap / polkit / ip rule）—— 走 pkexec 调 scripts/sbr-helper.sh，
 *      弹一次系统授权框。做不到的时候如实说明原因，不假装成功。
 *   3. 桌面集成（install-app.sh）—— 它最后会重启面板服务，也就是重启我们自己，
 *      所以脱离进程组后台跑，输出写日志文件，前端回头读。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { ROOT, DATA_DIR, settings } from './store.js'
import { clearCoreCache, findCore } from './core.js'

/** GitHub 拉不到 latest 时用这个版本（>= 1.12，配置 schema 对得上） */
const FALLBACK_VERSION = '1.12.4'
/** 低于这个版本生成的配置起不来：1.12 才有新版 DNS server 格式与 action 字段 */
const MIN_VERSION = [1, 12]

const ARCH_MAP = {
  x64: 'amd64',
  arm64: 'arm64',
  arm: 'armv7',
  ia32: '386',
  riscv64: 'riscv64',
  loong64: 'loong64'
}

const HELPER = path.join(ROOT, 'scripts', 'sbr-helper.sh')
const POLKIT_RULE = '/etc/polkit-1/rules.d/50-singbox-router.rules'
/**
 * polkit 规则装好时写的标记。Ubuntu 24.04 / Mint 22 起 /etc/polkit-1/rules.d
 * 是 root:polkitd 0700，面板（普通用户）读规则文件必然 EACCES —— 那不代表
 * 规则不存在。装规则成功时（authorizeTun / setup-tun.sh）写这份标记，
 * 读不到规则文件时就以它为准。
 */
const POLKIT_MARKER = path.join(DATA_DIR, 'polkit-rule.json')
const DESKTOP_LOG = path.join(DATA_DIR, 'desktop-install.log')

// ------------------------------------------------------------------ 小工具

function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, cmd)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {
      // 下一个
    }
  }
  return null
}

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.?(\d+)?/.exec(String(text || ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null
}

function ltVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x < y
  }
  return false
}

/** 镜像前缀拼法与 src/ruleset.js 一致：https://ghfast.top/ + 原始 URL */
function mirrored(url, mirror) {
  const m = String(mirror || '').trim()
  if (!m) return url
  return m.replace(/\/+$/, '') + '/' + url
}

async function fetchBuffer(url, timeout, label) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${label}超时（${Math.round(timeout / 1000)} 秒）`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// -------------------------------------------------------------- tar 读取

function cstr(buf) {
  const i = buf.indexOf(0)
  return buf.toString('utf8', 0, i === -1 ? buf.length : i)
}

/**
 * 极简 tar 读取，只为从 release 包里取出那一个可执行文件。
 *
 * 刻意不 spawn tar、也不解到磁盘：不建临时目录就不用事后清理，
 * 顺带避开"下载到一半的垃圾留在磁盘上"这种状态。
 */
function tarFind(buf, match) {
  let off = 0
  let longName = null
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    let allZero = true
    for (let i = 0; i < 512; i++) {
      if (h[i] !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) break // 结束块

    const size = parseInt(cstr(h.subarray(124, 136)).trim() || '0', 8)
    if (!Number.isInteger(size) || size < 0) break
    const type = String.fromCharCode(h[156])
    const prefix = cstr(h.subarray(345, 500))
    let name = cstr(h.subarray(0, 100))
    if (prefix) name = prefix + '/' + name
    if (longName !== null) {
      name = longName
      longName = null
    }

    const start = off + 512
    const end = start + size
    if (end > buf.length) break

    if (type === 'L') {
      longName = cstr(buf.subarray(start, end)) // GNU 长文件名
    } else if ((type === '0' || type === '\0') && match(name)) {
      return buf.subarray(start, end)
    }

    off = start + Math.ceil(size / 512) * 512
  }
  return null
}

// -------------------------------------------------------------- 内核下载

/** 内核往哪装：优先环境变量，其次程序目录 bin/，最后 ~/.local/bin（.deb 装法走这条） */
export function coreInstallDir() {
  const candidates = [
    process.env.SB_BIN_DIR,
    path.join(ROOT, 'bin'),
    path.join(os.homedir(), '.local', 'bin')
  ].filter(Boolean)

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      return dir
    } catch {
      // 不可写，下一个
    }
  }
  throw new Error(`没有可写的安装目录（试过：${candidates.join('、')}）`)
}

/**
 * 用哪个 GitHub 镜像：显式传的优先，否则跟着「规则集镜像」设置走。
 * 内核和规则集都从 GitHub 拉，用户为了绕墙填过一次，就不该在下内核时再问一遍。
 */
function pickMirror(explicit) {
  const given = String(explicit ?? '').trim()
  if (given) return given
  try {
    return String(settings().rulesetMirror || '').trim()
  } catch {
    return '' // 状态文件还读不出来（首次运行）就直连
  }
}

async function latestVersion(mirror, timeout) {
  const url = mirrored('https://api.github.com/repos/SagerNet/sing-box/releases/latest', mirror)
  const buf = await fetchBuffer(url, timeout, '查询最新版本')
  const tag = JSON.parse(buf.toString('utf8')).tag_name
  const v = String(tag || '').replace(/^v/, '')
  if (!parseVersion(v)) throw new Error(`GitHub 返回的版本号看不懂：${tag}`)
  return v
}

/**
 * 下载并安装 sing-box 内核（原 scripts/get-core.sh）。
 *
 * opts: { version, mirror, dir, timeout }
 */
export async function downloadCore(opts = {}) {
  if (process.platform !== 'linux') {
    throw new Error(`只支持 Linux，当前是 ${process.platform}。请自己装好 sing-box 后在设置里填内核路径。`)
  }
  const arch = ARCH_MAP[process.arch]
  if (!arch) throw new Error(`不认识的 CPU 架构 ${process.arch}，请自己装 sing-box 后在设置里填路径`)

  const mirror = pickMirror(opts.mirror)
  const timeout = Number(opts.timeout) || 180000
  const steps = []

  // ---- 版本 ----
  let version = String(opts.version || '').replace(/^v/, '').trim()
  if (version) {
    if (!parseVersion(version)) throw new Error(`版本号格式不对：${opts.version}`)
    steps.push(`指定版本 ${version}`)
  } else {
    try {
      version = await latestVersion(mirror, Math.min(timeout, 20000))
      steps.push(`最新版本 ${version}`)
    } catch (e) {
      version = FALLBACK_VERSION
      steps.push(`查不到最新版本（${e.message}），退回 ${version}`)
    }
  }
  const parsed = parseVersion(version)
  if (ltVersion(parsed, MIN_VERSION)) {
    throw new Error(
      `sing-box ${version} 太旧。本项目生成的是 1.12 的配置 schema（新版 DNS server 格式、action 字段），` +
        `1.12 以下会因未知字段启动失败。`
    )
  }

  // ---- 下载 ----
  const name = `sing-box-${version}-linux-${arch}`
  const url = mirrored(
    `https://github.com/SagerNet/sing-box/releases/download/v${version}/${name}.tar.gz`,
    mirror
  )
  steps.push(`下载 ${url}`)
  const tgz = await fetchBuffer(url, timeout, '下载内核')
  if (tgz.length < 1024 * 1024) {
    throw new Error(`下载到的文件只有 ${tgz.length} 字节，不像是内核包（可能是错误页或被拦截）`)
  }

  // ---- 解包 ----
  let tar
  try {
    tar = zlib.gunzipSync(tgz)
  } catch {
    throw new Error(`下载到的不是 .tar.gz（${tgz.length} 字节，可能是错误页或被拦截）`)
  }
  const bin = tarFind(tar, (n) => path.basename(n) === 'sing-box')
  if (!bin) throw new Error('压缩包里没找到 sing-box 可执行文件')
  // ELF 魔数：和 ruleset 那边校验 .srs 魔数同一个道理，挡住错误页伪装成二进制
  if (!(bin.length > 4 && bin[0] === 0x7f && bin[1] === 0x45 && bin[2] === 0x4c && bin[3] === 0x46)) {
    throw new Error(`解出来的不是 Linux 可执行文件（${bin.length} 字节）`)
  }
  steps.push(`解出可执行文件 ${(bin.length / 1048576).toFixed(1)} MB`)

  // ---- 落盘 ----
  const dir = opts.dir ? path.resolve(opts.dir) : coreInstallDir()
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, 'sing-box')
  const tmp = dest + '.download'
  fs.writeFileSync(tmp, bin, { mode: 0o755 })
  fs.chmodSync(tmp, 0o755)
  // rename 是原子的；正在跑的旧内核持有旧 inode，不会被这一步打断
  fs.renameSync(tmp, dest)
  steps.push(`安装到 ${dest}`)

  clearCoreCache()

  // ---- 验证 ----
  let versionLine = null
  try {
    versionLine = execFileSync(dest, ['version'], { encoding: 'utf8', timeout: 8000 }).trim().split('\n')[0]
  } catch (e) {
    throw new Error(`装好了但跑不起来（${dest}）：${e.message}`)
  }

  // capability 是绑在 inode 上的，覆盖内核等于把之前的 setcap 冲掉了
  const capLost = fs.existsSync(POLKIT_RULE)

  return {
    ok: true,
    version,
    arch,
    path: dest,
    size: bin.length,
    versionLine,
    steps,
    // 换了二进制就得重新 setcap，否则 TUN 会突然报权限不足
    needsReauthorize: capLost,
    message: `已安装 ${versionLine}（${dest}）`
  }
}

// -------------------------------------------------------------- 提权通道

/**
 * 会话环境。面板后端由 systemd --user 拉起，未必继承得到 DISPLAY /
 * DBUS_SESSION_BUS_ADDRESS —— 没有它们 polkit 弹不出授权框。
 *
 * 于是按两条路补：先问用户级 systemd 的环境块（大多数桌面登录时会
 * import-environment 进去），再退回翻我们自己那两个 GUI 进程的 environ。
 * 都是同一个 uid 自己的东西，不越权。
 */
export function sessionEnv() {
  const keys = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']
  const out = {}
  for (const k of keys) if (process.env[k]) out[k] = process.env[k]

  if (!out.DISPLAY && !out.WAYLAND_DISPLAY) {
    try {
      const text = execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', timeout: 4000 })
      for (const line of text.split('\n')) {
        const i = line.indexOf('=')
        if (i <= 0) continue
        const k = line.slice(0, i)
        if (keys.includes(k) && !out[k]) out[k] = line.slice(i + 1)
      }
    } catch {
      // systemctl 不可用就算了
    }
  }

  if (!out.DISPLAY && !out.WAYLAND_DISPLAY) {
    for (const pid of ourGuiPids()) {
      try {
        const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
        for (const item of raw.split('\0')) {
          const i = item.indexOf('=')
          if (i <= 0) continue
          const k = item.slice(0, i)
          if (keys.includes(k) && !out[k]) out[k] = item.slice(i + 1)
        }
        if (out.DISPLAY || out.WAYLAND_DISPLAY) break
      } catch {
        // 进程没了或读不了，下一个
      }
    }
  }
  return out
}

/** 我们自己的托盘 / 窗口进程（它们一定坐在图形会话里） */
function ourGuiPids() {
  const pids = []
  let entries = []
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return pids
  }
  const uid = process.getuid ? process.getuid() : -1
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    try {
      if (uid >= 0 && fs.statSync(`/proc/${name}`).uid !== uid) continue
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8')
      if (/app\/(gui|window)\.py/.test(cmd)) pids.push(name)
    } catch {
      // 下一个
    }
  }
  return pids
}

/** 能不能弹出授权框 */
export function escalation() {
  const env = sessionEnv()
  const pkexec = which('pkexec')
  const graphical = !!(env.DISPLAY || env.WAYLAND_DISPLAY)

  if (pkexec && graphical) return { ok: true, method: 'pkexec', graphical: true, env }
  if (pkexec) {
    return {
      ok: true,
      method: 'pkexec',
      graphical: false,
      env,
      warn: '当前进程看不到图形会话（DISPLAY 为空），授权框可能弹不出来。弹不出来时请用托盘菜单里的同名操作。'
    }
  }
  return {
    ok: false,
    method: null,
    graphical,
    env,
    reason: 'no-pkexec',
    hint: '系统里没有 pkexec（policykit-1 / polkit 没装），无法申请管理员权限。装一下：sudo apt install policykit-1'
  }
}

/** 用 pkexec 跑特权助手。返回 { ok, code, output } —— 失败时把 stderr 原样带回去 */
function runHelper(args, timeout, opts = {}) {
  // 在终端里跑（npm run / 包装脚本）时走另一条路：那里有 tty，让用户直接输密码
  // 才是对的，反而不该切断终端。
  if (opts.tty) return runHelperTty(args, timeout)

  const esc = escalation()
  if (!esc.ok) return Promise.resolve({ ok: false, reason: esc.reason, error: esc.hint })
  if (!fs.existsSync(HELPER)) {
    return Promise.resolve({ ok: false, reason: 'no-helper', error: `特权助手不在：${HELPER}` })
  }

  // 助手有执行位就直接跑（授权框上显示的是它自己的路径，用户看得懂在授权什么）；
  // 没有就借 bash 跑，免得因为 clone 出来丢了执行位而卡住。
  let argv
  try {
    fs.accessSync(HELPER, fs.constants.X_OK)
    argv = [HELPER, ...args]
  } catch {
    argv = ['/bin/bash', HELPER, ...args]
  }

  return new Promise((resolve) => {
    let out = ''
    const child = spawn('pkexec', argv, {
      // detached：切断控制终端。否则在终端里跑面板时 pkexec 会在那个终端上
      // 要密码，而 HTTP 请求已经在等它，等于把面板挂住。切断后它只能走
      // 图形授权代理，弹不出来就立刻失败，不会卡。
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...esc.env }
    })
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill('SIGTERM')
      }
      resolve({ ok: false, reason: 'timeout', error: `等授权超时（${Math.round(timeout / 1000)} 秒），已放弃`, output: out })
    }, timeout)

    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (out += d.toString('utf8')))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: 'spawn', error: e.message, output: out })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const output = out.trim()
      if (code === 0) return resolve({ ok: true, code, output, graphical: esc.graphical })

      // pkexec 自己的退出码：126 = 用户取消/授权失败，127 = 找不到授权代理或程序
      let reason = 'failed'
      let error = output.split('\n').filter(Boolean).slice(-3).join('\n') || `退出码 ${code}`
      if (code === 126) {
        reason = 'denied'
        error = '授权被取消或密码不对'
      } else if (code === 127 || /authentication agent|Error executing/i.test(output)) {
        reason = 'no-agent'
        error =
          '没有可用的图形授权代理。面板后端由 systemd --user 托管，未必在图形会话里 —— ' +
          '请改用**托盘菜单**里的同名操作（托盘本身就是图形程序，一定弹得出来）。'
      }
      resolve({ ok: false, reason, code, error, output, graphical: esc.graphical })
    })
    child.unref()
  })
}

/**
 * 终端版：stdio 直通，让 pkexec / sudo 在当前终端里要密码。
 * 已经是 root 就直接跑，不多绕一层。
 */
function runHelperTty(args, timeout) {
  if (!fs.existsSync(HELPER)) {
    return Promise.resolve({ ok: false, reason: 'no-helper', error: `特权助手不在：${HELPER}` })
  }
  const root = process.getuid && process.getuid() === 0
  let cmd
  let argv
  if (root) {
    cmd = '/bin/bash'
    argv = [HELPER, ...args]
  } else if (which('pkexec')) {
    cmd = 'pkexec'
    argv = ['/bin/bash', HELPER, ...args]
  } else if (which('sudo')) {
    cmd = 'sudo'
    argv = ['/bin/bash', HELPER, ...args]
  } else {
    return Promise.resolve({
      ok: false,
      reason: 'no-escalation',
      error: '既没有 pkexec 也没有 sudo，无法取得管理员权限。请用 root 身份再跑一次。'
    })
  }

  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: 'inherit', env: process.env })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: 'spawn', error: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(
        code === 0
          ? { ok: true, code, output: '', tty: true }
          : { ok: false, reason: code === 126 ? 'denied' : 'failed', code, error: `退出码 ${code}` }
      )
    })
  })
}

/** polkit 免密规则装了没（装了就说明授权跑过一次） */
export function polkitRuleStatus() {
  const user = os.userInfo().username
  try {
    const text = fs.readFileSync(POLKIT_RULE, 'utf8')
    return { present: true, forCurrentUser: text.includes(`"${user}"`), path: POLKIT_RULE }
  } catch (e) {
    // EACCES ≠ 规则不存在：polkit 121+（Ubuntu 24.04 / Mint 22 起）的规则目录是
    // root:polkitd 0700，普通用户读不了。装规则时写过标记的话，以标记为准。
    if (e && e.code === 'EACCES') {
      try {
        const m = JSON.parse(fs.readFileSync(POLKIT_MARKER, 'utf8'))
        if (m && m.user) {
          return { present: true, forCurrentUser: m.user === user, via: 'marker', path: POLKIT_RULE }
        }
      } catch {
        // 标记也没有（规则是老版本装的）—— 只能如实说"读不到、无法复核"
      }
      return { present: false, unreadable: true, path: POLKIT_RULE }
    }
    return { present: false, path: POLKIT_RULE }
  }
}

/** 装规则成功后写标记（规则文件本身普通用户读不了，见 POLKIT_MARKER 注释） */
function writePolkitMarker(user) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(POLKIT_MARKER, JSON.stringify({ at: Date.now(), user }, null, 2))
  } catch {
    // 标记写失败不影响授权本身，只是下次 doctor 复核不到
  }
}

/**
 * 一次性授权 TUN（原 scripts/setup-tun.sh）：给内核加 CAP_NET_ADMIN + 装 polkit 免密规则。
 * 之后启停 TUN 都不再要密码。
 *
 * opts.tty：在终端里跑，让 pkexec/sudo 直接在当前终端要密码。
 */
export async function authorizeTun(opts = {}) {
  const core = findCore()
  if (!core) {
    return { ok: false, reason: 'no-core', error: '还没有内核。先在「引导 / 问题排查」里点「下载内核」。' }
  }
  const user = os.userInfo().username
  const r = await runHelper(['authorize-tun', core, user], 180000, opts)
  if (r.ok) {
    clearCoreCache() // capability 变了，缓存的判断结果作废
    writePolkitMarker(user) // 规则文件普通用户读不了（polkit 121+ 0700），靠标记复核
  }
  return { ...r, core, user, polkit: polkitRuleStatus() }
}

/**
 * TUN 残留急救（原 scripts/tun-recover.sh）：删掉我们自己那段策略路由和网卡。
 * 内核被 SIGKILL 或机器硬崩之后，残留路由会指向已消失的网卡 —— 那是整机断网。
 */
export async function recoverTun(opts = {}) {
  // 默认值必须来自设置，不能写死：用户改过网卡名/表索引的话，写死的那套清不掉他的残留
  let s = {}
  try {
    s = settings()
  } catch {
    // 状态文件读不出来时退回内置默认值
  }
  const iface = String(opts.interface || s.tunInterface || 'sbr-tun')
  const table = String(Number(opts.tableIndex || s.tunTableIndex) || 2023)
  const ruleBase = String(Number(opts.ruleIndex || s.tunRuleIndex) || 9100)
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,14}$/.test(iface)) {
    return { ok: false, reason: 'bad-arg', error: `网卡名不合法：${iface}` }
  }
  return runHelper(['recover-tun', iface, table, ruleBase], 120000, opts)
}

/** 重启网络服务 —— 急救之后网关还是不通时的第二板斧 */
export async function restartNetwork(opts = {}) {
  return runHelper(['restart-network'], 120000, opts)
}

// ---------------------------------------------------------- 桌面集成

/** 是不是从 .deb 装的（那种情况下桌面集成已经由 dpkg 做好了） */
export function packagedInstall() {
  return ROOT.startsWith('/usr/')
}

export function desktopIntegration() {
  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'singbox-router.service')
  const autostart = path.join(os.homedir(), '.config', 'autostart', 'singbox-router-tray.desktop')
  return {
    packaged: packagedInstall(),
    userUnit: fs.existsSync(unit),
    userAutostart: fs.existsSync(autostart),
    systemUnit: fs.existsSync('/usr/lib/systemd/user/singbox-router.service'),
    logFile: DESKTOP_LOG
  }
}

/**
 * 装 / 卸桌面集成（原 scripts/install-app.sh、uninstall-app.sh）。
 *
 * 这两个脚本最后都会动 singbox-router.service —— 也就是**我们自己这个进程**。
 * 所以必须脱离进程组后台跑，并且立刻把响应还给前端；输出写到日志文件，
 * 服务重启完前端再来读。同步等它结束是不可能的：等不到自己被杀。
 */
export function runDesktopScript(which_) {
  const file = which_ === 'uninstall' ? 'uninstall-app.sh' : 'install-app.sh'
  const script = path.join(ROOT, 'scripts', file)
  if (!fs.existsSync(script)) throw new Error(`找不到 ${script}`)
  if (packagedInstall()) {
    throw new Error('这是 .deb 装法，桌面集成由 dpkg 管理，不要再跑源码目录那套脚本（两边文件名相同会互相盖）')
  }

  fs.mkdirSync(DATA_DIR, { recursive: true })
  const header = `\n===== ${new Date().toISOString()} ${file} =====\n`
  fs.writeFileSync(DESKTOP_LOG, header)
  const fd = fs.openSync(DESKTOP_LOG, 'a')

  const child = spawn('bash', [script], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: {
      ...process.env,
      // 脚本要往 systemd 单元里写 ExecStart 的绝对路径。用户服务不读 .zshrc，
      // 脚本自己 command -v node 可能什么都找不到（nvm）。正在跑面板的这个
      // node 一定是能用的，直接告诉它。
      SBR_NODE: process.execPath,
      // 让脚本在起 systemd 服务之前先请我们退出，把面板端口交出去。
      SBR_HANDOFF_PID: String(process.pid)
    }
  })
  child.unref()
  fs.closeSync(fd)

  return {
    ok: true,
    started: true,
    script,
    log: DESKTOP_LOG,
    message:
      which_ === 'uninstall'
        ? '已在后台卸载桌面集成。面板服务会被停掉，这个页面随后会断开 —— 那是正常的。'
        : '已在后台安装桌面集成。面板服务会重启，这个页面会断开几秒然后自己连回来。'
  }
}

export function desktopLog(limit = 8000) {
  try {
    const text = fs.readFileSync(DESKTOP_LOG, 'utf8')
    return { ok: true, path: DESKTOP_LOG, text: text.length > limit ? text.slice(-limit) : text }
  } catch {
    return { ok: false, path: DESKTOP_LOG, text: '' }
  }
}
