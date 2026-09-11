/**
 * 问题排查（doctor）—— 把"为什么起不来 / 为什么不走代理"这类问题一次查完。
 *
 * 每项检查产出一条结构化结果：
 *
 *   { id, title, level, detail, fix?: { action, label }, more? }
 *
 * level：ok（正常）| info（只是告知）| warn（能用但有隐患）| err（现在就是坏的）
 * fix：能一键修的才给。**这是这个模块存在的理由** —— 光告诉用户"缺 CAP_NET_ADMIN"
 * 而让他自己去开终端敲 setup-tun.sh，等于没解决问题。
 *
 * 检查本身不改任何东西（除了必然的读缓存），跑多少遍都一样。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DATA_DIR, LEGACY_DATA_DIR, STATE_FILE, getState, lastMigration } from './store.js'
import * as core from './core.js'
import * as ruleset from './ruleset.js'
import * as setup from './setup.js'
import * as sysproxy from './sysproxy.js'
import * as termproxy from './termproxy.js'
import { graphicalEnv } from './open.js'
import { validate } from './config.js'

/** 生成的配置用的是 1.12 schema，比这个旧的内核会因为未知字段直接起不来 */
const MIN_CORE = [1, 12]
const MIN_NODE = 20

function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function parseVer(text) {
  const m = /(\d+)\.(\d+)\.?(\d+)?/.exec(String(text || ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null
}

function has(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK)
      return true
    } catch {
      // 下一个
    }
  }
  return false
}

// ------------------------------------------------------------------ 各项检查

function checkNode() {
  const major = Number(process.versions.node.split('.')[0])
  if (major >= MIN_NODE) {
    return { id: 'node', title: 'Node.js 版本', level: 'ok', detail: `v${process.versions.node}` }
  }
  return {
    id: 'node',
    title: 'Node.js 版本',
    level: 'err',
    detail: `当前 v${process.versions.node}，本程序要求 >= ${MIN_NODE}`,
    more:
      '面板现在能开，说明它勉强跑起来了，但用到的一些语法/API 在旧版上行为不同。' +
      '用 nvm 装一个新版（nvm install 22），或换发行版的 nodejs 新版包。'
  }
}

function checkCore() {
  const found = core.findCore()
  if (!found) {
    return {
      id: 'core',
      title: 'sing-box 内核',
      level: 'err',
      detail: '没找到可执行文件',
      more: '内核不含在本程序里（几十 MB、按 CPU 架构分发、还要单独授权），需要下载一次。',
      fix: { action: 'download-core', label: '下载内核' }
    }
  }
  const line = core.coreVersion()
  const v = parseVer(line)
  if (!v) {
    return {
      id: 'core',
      title: 'sing-box 内核',
      level: 'warn',
      detail: `${found}（跑 version 没拿到版本号）`,
      more: '文件在，但执行 `sing-box version` 没有正常输出 —— 可能是架构不对或文件损坏。',
      fix: { action: 'download-core', label: '重新下载内核' }
    }
  }
  if (cmp(v, MIN_CORE) < 0) {
    return {
      id: 'core',
      title: 'sing-box 内核',
      level: 'err',
      detail: `${line} 太旧（需要 >= ${MIN_CORE.join('.')}）`,
      more:
        '本程序生成的是 sing-box 1.12 的配置格式（新版 DNS server 写法、action 字段）。' +
        '1.12 以下的内核遇到未知字段会直接拒绝启动。',
      fix: { action: 'download-core', label: '下载新版内核' }
    }
  }
  return { id: 'core', title: 'sing-box 内核', level: 'ok', detail: `${line}\n${found}` }
}

function checkDataDir() {
  const items = []
  let writable = false
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.accessSync(DATA_DIR, fs.constants.W_OK)
    writable = true
  } catch (e) {
    items.push(e.message)
  }
  if (!writable) {
    return {
      id: 'data-dir',
      title: '配置目录',
      level: 'err',
      detail: `${DATA_DIR} 不可写`,
      more: `设置、节点、订阅凭据都存在这里，写不进去等于什么都存不下来。\n${items.join('\n')}`
    }
  }

  const mig = lastMigration()
  if (mig && mig.ok) {
    return {
      id: 'data-dir',
      title: '配置目录',
      level: 'info',
      detail: DATA_DIR,
      more:
        `本次启动从旧目录复制了 ${mig.copied.length} 项（${mig.copied.join('、') || '无'}）。\n` +
        `旧目录 ${mig.from} 原样留着没动，确认新目录一切正常后可以自己清理。`
    }
  }
  if (mig && !mig.ok) {
    return {
      id: 'data-dir',
      title: '配置目录',
      level: 'warn',
      detail: `从 ${mig.from} 迁移时出错：${mig.error}`,
      more: '程序仍然使用新目录，但旧数据可能没全带过来。可以手动把文件复制过去。'
    }
  }

  // 旧目录还在、但新目录已经有状态了 —— 用户可能正在改错的那份
  let legacyNote = ''
  if (LEGACY_DATA_DIR !== DATA_DIR && fs.existsSync(path.join(LEGACY_DATA_DIR, 'state.json'))) {
    legacyNote = `\n注意：${LEGACY_DATA_DIR} 里还有一份旧 state.json，程序**不读它**了。`
  }
  return {
    id: 'data-dir',
    title: '配置目录',
    level: 'ok',
    detail: DATA_DIR + legacyNote,
    more: fs.existsSync(STATE_FILE) ? undefined : '还没有 state.json —— 这是第一次运行。'
  }
}

async function checkPorts(running) {
  const s = getState().settings
  if (running) {
    return {
      id: 'ports',
      title: '端口占用',
      level: 'ok',
      detail: '内核正在运行，端口已由它持有（此项跳过）'
    }
  }
  const busy = await core.busyPorts()
  if (!busy.length) {
    return {
      id: 'ports',
      title: '端口占用',
      level: 'ok',
      detail: `主端口 ${s.mainPort} / Clash API ${s.clashApiPort} 及各节点端口都空着`
    }
  }
  return {
    id: 'ports',
    title: '端口占用',
    level: 'err',
    detail: busy.map((b) => `${b.port}（${b.who}）已被占用`).join('\n'),
    more:
      '内核启动时抢不到端口就会立刻退出。看看是谁占着：\n' +
      busy.map((b) => `  ss -ltnp 'sport = :${b.port}'`).join('\n') +
      '\n通常是上一次没退干净，或者别的代理客户端在跑。改端口也行。'
  }
}

function checkConfigIssues() {
  let issues = []
  try {
    issues = validate()
  } catch (e) {
    return { id: 'config', title: '配置自检', level: 'err', detail: `跑不动自检：${e.message}` }
  }
  // 端口冲突和规则集缺失另有专项检查，这里去掉，免得同一件事报两遍
  const rest = issues.filter((x) => !/^端口 \d+ 被重复占用/.test(x) && !/国内自动分流缺少规则集/.test(x))
  const dup = issues.filter((x) => /^端口 \d+ 被重复占用/.test(x))

  if (dup.length) {
    return {
      id: 'config',
      title: '配置自检',
      level: 'err',
      detail: dup.concat(rest).join('\n'),
      more: '同一个端口被两处占用时，后一个 inbound 会让内核启动失败。去设置里改一个。'
    }
  }
  if (!rest.length) return { id: 'config', title: '配置自检', level: 'ok', detail: '没有发现问题' }

  // "没有已启用的代理节点"在刚装好时是必然的，算 info 不算 warn
  const onlyEmpty = rest.length === 1 && rest[0].includes('没有已启用的代理节点')
  return {
    id: 'config',
    title: '配置自检',
    level: onlyEmpty ? 'info' : 'warn',
    detail: rest.join('\n'),
    more: onlyEmpty ? '先去「订阅」或「导入」加几个节点。' : undefined
  }
}

function checkRulesets() {
  const s = getState().settings
  const st = ruleset.status()
  const missing = st.filter((x) => !x.present)
  const source = ruleset.effectiveSource()

  if (!s.chinaDirect) {
    return {
      id: 'rulesets',
      title: '国内自动分流规则集',
      level: 'ok',
      detail: '国内自动分流没开（默认关），不需要规则集',
      more: missing.length ? undefined : '规则集已下载好，开开关就能直接用。'
    }
  }
  if (!missing.length) {
    return {
      id: 'rulesets',
      title: '国内自动分流规则集',
      level: 'ok',
      detail: st.map((x) => `${x.file} ${(x.size / 1024).toFixed(0)} KB`).join('\n') + `\n来源：本地文件`
    }
  }
  if (source === 'remote') {
    return {
      id: 'rulesets',
      title: '国内自动分流规则集',
      level: 'warn',
      detail: `缺 ${missing.map((m) => m.file).join('、')}，当前会由内核自己远程拉取`,
      more:
        '远程模式带 download_detour: proxy —— 规则集在墙外，得先有能用的节点才拉得下来。' +
        '启动会因此多等一会儿，拉失败则该层分流静默失效。建议先下到本地。',
      fix: { action: 'download-rulesets', label: '下载规则集' }
    }
  }
  return {
    id: 'rulesets',
    title: '国内自动分流规则集',
    level: 'err',
    detail: `本地模式缺文件：${missing.map((m) => m.file).join('、')}`,
    more: '来源设成了「只用本地」，缺文件时内核会直接启动失败。',
    fix: { action: 'download-rulesets', label: '下载规则集' }
  }
}

function checkTun() {
  const s = getState().settings
  const cap = core.tunCapability()
  const polkit = setup.polkitRuleStatus()

  if (cap.ok) {
    const via = cap.via === 'root' ? '以 root 运行' : 'setcap 已授权'
    let more
    if (!polkit.present) {
      more =
        'capability 有了，但没有 polkit 免密规则 —— TUN 模式下内核要通过 systemd-resolved ' +
        '设置本网卡 DNS，每次启停都会弹一次密码框。点「一次性授权 TUN」把这条也补上。'
    } else if (!polkit.forCurrentUser) {
      more = `${polkit.path} 存在但里面不是当前用户（${os.userInfo().username}），启停时仍会弹框。`
    }
    return {
      id: 'tun',
      title: 'TUN 权限',
      level: more ? 'warn' : 'ok',
      detail: `${via}${polkit.present ? '，polkit 免密规则已装' : ''}`,
      more,
      fix: more ? { action: 'authorize-tun', label: '一次性授权 TUN' } : undefined
    }
  }

  if (cap.reason === 'no-core') {
    return {
      id: 'tun',
      title: 'TUN 权限',
      level: 'info',
      detail: '还没有内核，无法检查',
      more: '先下载内核，再回来授权 TUN。',
      fix: { action: 'download-core', label: '下载内核' }
    }
  }
  return {
    id: 'tun',
    title: 'TUN 权限',
    // TUN 没开时缺权限不是"现在坏了"，只是"开了会坏"
    level: s.tunEnabled ? 'err' : 'info',
    detail: '内核缺少 CAP_NET_ADMIN' + (has('getcap') ? '' : '（系统里也没有 getcap，无法确认）'),
    more:
      'TUN 要建虚拟网卡、改策略路由，这两件事需要 CAP_NET_ADMIN。' +
      '点下面的按钮授权一次（会弹一个系统授权框），之后启停 TUN 都不再要密码。' +
      (s.tunEnabled ? '' : '\n当前 TUN 开关是关的，不影响普通代理模式。'),
    fix: { action: 'authorize-tun', label: '一次性授权 TUN' }
  }
}

function checkStaleTun() {
  const stale = core.staleTunState()
  if (!stale.length) {
    return { id: 'stale-tun', title: 'TUN 残留', level: 'ok', detail: '没有残留网卡或策略路由' }
  }
  return {
    id: 'stale-tun',
    title: 'TUN 残留',
    level: 'err',
    detail: stale.join('\n'),
    more:
      '上一次内核没有正常退出（被 SIGKILL、或者机器直接断电），策略路由留了下来，' +
      '而它指向的网卡已经不存在了 —— 表现就是整机上不了网。点「清理 TUN 残留」修掉。',
    fix: { action: 'recover-tun', label: '清理 TUN 残留' }
  }
}

function checkConflicts() {
  const list = core.globalProxyConflicts()
  if (!list.length) {
    return { id: 'conflicts', title: '其它代理程序', level: 'ok', detail: '没有发现同类程序在跑' }
  }
  return {
    id: 'conflicts',
    title: '其它代理程序',
    level: 'warn',
    detail: list.map((c) => `${c.name}（${c.how}）`).join('\n'),
    more:
      '两个程序同时做全局流量捕获，路由会互相覆盖，症状是"时好时坏"。' +
      '开 TUN 之前先把它们退掉。只做普通端口代理的话可以共存。'
  }
}

async function checkEscalation() {
  const esc = setup.escalation()
  if (!esc.ok) {
    return {
      id: 'escalation',
      title: '管理员授权通道',
      level: 'warn',
      detail: esc.hint,
      more: '影响范围只有 TUN 授权和断网急救这两件事，普通代理不需要任何权限。'
    }
  }
  if (!esc.graphical) {
    return {
      id: 'escalation',
      title: '管理员授权通道',
      level: 'warn',
      detail: '找到 pkexec，但当前进程看不到图形会话（DISPLAY / WAYLAND_DISPLAY 都是空的）',
      more:
        '面板后端由 systemd --user 托管，某些桌面不会把 DISPLAY 导入进去，于是授权框弹不出来。' +
        '这种情况下改用**托盘菜单**里的同名操作 —— 托盘本身就是图形程序，一定弹得出来。'
    }
  }
  return { id: 'escalation', title: '管理员授权通道', level: 'ok', detail: 'pkexec 可用，能弹出系统授权框' }
}

async function checkSysproxy() {
  const s = getState().settings
  const ok = await sysproxy.available()
  const st = sysproxy.state()
  if (!ok) {
    return {
      id: 'sysproxy',
      title: '系统代理接管',
      level: s.autoSetSystemProxy ? 'warn' : 'info',
      detail: 'gsettings 不可用（不是 GNOME/Cinnamon/MATE 系桌面？）',
      more:
        `接管系统代理这条路走不通。两个替代：TUN 模式（全局生效，不依赖桌面设置），` +
        `或者 source ${st.envFile} 给终端程序用。`
    }
  }
  if (st.managed) {
    return {
      id: 'sysproxy',
      title: '系统代理接管',
      level: 'info',
      detail: `已接管，指向 127.0.0.1:${st.port}（${st.since ? new Date(st.since).toLocaleString('zh-CN') : '时间未知'} 起）`,
      more: '停止内核会自动还原成接管前的值（备份存在配置目录里，面板重启也不会丢）。'
    }
  }
  return { id: 'sysproxy', title: '系统代理接管', level: 'ok', detail: 'gsettings 可用，当前未接管' }
}

/**
 * 终端代理接管。
 *
 * 单独一项而不是并进 sysproxy，因为它们解决的是两拨程序的问题：
 * gsettings 那套只有图形程序读，curl / git / npm / pip / apt 只认 http_proxy。
 * 「系统代理已接管，但终端里 git clone 还是不通」几乎全是这一项没做。
 */
function checkTermProxy() {
  const t = termproxy.state()
  const broken = t.shells.filter((x) => x.dangling)
  if (broken.length) {
    return {
      id: 'termproxy',
      title: '终端代理接管',
      level: 'warn',
      detail: `${broken.map((x) => x.rc).join('、')} 里的标记不成对`,
      more:
        '只找到开始标记、没找到结束标记 —— 为了不误删你自己的内容，程序不会去动它。' +
        '请打开这个文件，手动删掉 “# >>> singbox-router 终端代理 >>>” 那一段。'
    }
  }
  if (t.managed) {
    const where = t.shells.filter((x) => x.hooked).map((x) => `${x.shell}(${x.rc})`)
    return {
      id: 'termproxy',
      title: '终端代理接管',
      level: 'ok',
      detail: `已挂到 ${where.join('、')}，新开的终端自动走 127.0.0.1:${t.port}`,
      more:
        `已经开着的终端不会自动生效（谁也改不了别的进程的环境变量），在里面执行一次：\n` +
        `${t.sourceLine}\n` +
        `临时开关：proxyon / proxyoff / proxystatus。` +
        (t.snippetFresh ? '' : ' ⚠ 片段里的端口和当前设置不一致，点「保存设置」重写一次。')
    }
  }
  return {
    id: 'termproxy',
    title: '终端代理接管',
    level: 'info',
    detail: '未接管 —— 终端里的 curl / git / npm / pip / apt 目前不走代理',
    more:
      '图形程序的代理由「系统代理」管，命令行工具一概不认那套，它们只看 http_proxy 这类环境变量。' +
      '要么在这里点一下接管（往 shell 启动脚本挂一段，以后新开的终端自动带上），要么开 TUN 全局代理。',
    fix: { action: 'takeover-terminal', label: '接管终端代理' }
  }
}

function checkGraphical() {
  const g = graphicalEnv()
  const openers = ['xdg-open', 'nemo', 'nautilus', 'thunar', 'dolphin', 'caja', 'pcmanfm'].filter(has)
  if (g.ok && openers.length) {
    return {
      id: 'graphical',
      title: '打开配置文件夹',
      level: 'ok',
      detail: `可用的文件管理器：${openers.join('、')}`
    }
  }
  if (!openers.length) {
    return {
      id: 'graphical',
      title: '打开配置文件夹',
      level: 'warn',
      detail: '系统里没有 xdg-open 也没有常见文件管理器',
      more: `装一个：sudo apt install xdg-utils。点按钮时会退而复制路径到剪贴板：\n${DATA_DIR}`
    }
  }
  return {
    id: 'graphical',
    title: '打开配置文件夹',
    level: 'warn',
    detail: '有文件管理器，但当前进程看不到图形会话',
    more: '面板按钮可能打不开窗口，改用托盘菜单里的「打开配置文件夹」。'
  }
}

function checkDesktop() {
  const d = setup.desktopIntegration()
  if (d.packaged) {
    return {
      id: 'desktop',
      title: '桌面集成',
      level: 'ok',
      detail: '.deb 安装，开始菜单项、用户服务、托盘自启都由包管理',
      more: d.userUnit
        ? `注意：~/.config/systemd/user 里还有一份同名单元，它会**盖住**包里那份。` +
          `如果那份指向的目录已经挪走了，面板就起不来 —— 把它删掉或改名。`
        : undefined
    }
  }
  if (d.userUnit && d.userAutostart) {
    return {
      id: 'desktop',
      title: '桌面集成',
      level: 'ok',
      detail: '已安装（用户级 systemd 服务 + 托盘自启 + 开始菜单项）'
    }
  }
  return {
    id: 'desktop',
    title: '桌面集成',
    level: 'info',
    detail: '还没装 —— 现在是"开着终端跑"的状态，关掉终端面板就停了',
    more:
      '装了之后：登录自动起后端和托盘，开始菜单里有图标，不需要再手动敲命令。\n' +
      '装的只是当前用户自己的文件（~/.config/systemd/user、~/.local/bin、~/.local/share/applications），不需要 root。',
    fix: { action: 'install-desktop', label: '安装桌面集成' }
  }
}

function checkCoreRunning(running, st) {
  if (running) {
    const secs = st.startedAt ? Math.round((Date.now() - st.startedAt) / 1000) : null
    return {
      id: 'running',
      title: '内核状态',
      level: 'ok',
      detail: `正在运行（PID ${st.pid}${secs !== null ? `，已运行 ${secs} 秒` : ''}）`
    }
  }
  return { id: 'running', title: '内核状态', level: 'info', detail: '未运行' }
}

// ------------------------------------------------------------------ 汇总

/**
 * 跑全部检查。
 * @param {{dirty?: boolean}} ctx 面板传进来的"有改动未应用"标记
 */
export async function run(ctx = {}) {
  const st = core.status()
  const running = !!st.running

  const checks = [
    checkNode(),
    checkCore(),
    checkDataDir(),
    await checkPorts(running),
    checkConfigIssues(),
    checkRulesets(),
    checkTun(),
    checkStaleTun(),
    checkConflicts(),
    await checkEscalation(),
    await checkSysproxy(),
    checkTermProxy(),
    checkGraphical(),
    checkDesktop(),
    checkCoreRunning(running, st)
  ]

  if (ctx.dirty) {
    checks.push({
      id: 'dirty',
      title: '待应用的改动',
      level: 'warn',
      detail: '配置改过了，但还没让内核重新加载',
      more: '端口、节点、规则这些改动要「应用配置」（重启内核）才生效。',
      fix: { action: 'apply', label: '应用配置' }
    })
  }

  const summary = { ok: 0, info: 0, warn: 0, err: 0 }
  for (const c of checks) summary[c.level] = (summary[c.level] || 0) + 1

  return {
    checks,
    summary,
    // 有 err 就是"现在有东西是坏的"；只有 warn 说明能用但有隐患
    healthy: summary.err === 0,
    generatedAt: Date.now(),
    env: {
      node: process.versions.node,
      platform: `${os.type()} ${os.release()}`,
      arch: process.arch,
      user: os.userInfo().username,
      dataDir: DATA_DIR,
      desktop: process.env.XDG_CURRENT_DESKTOP || '未知',
      root: process.getuid ? process.getuid() === 0 : false
    }
  }
}

/**
 * 一份能直接贴到 issue 里的纯文本报告。
 *
 * 刻意只输出上面那些检查项的结论 —— 不含节点、订阅地址、密码、Clash secret。
 * 用户拿它去求助时不用自己想着打码。
 */
export function textReport(result) {
  const icon = { ok: '✓', info: 'i', warn: '!', err: '✗' }
  const lines = [
    '# singbox-router 排查报告',
    `时间：${new Date(result.generatedAt).toLocaleString('zh-CN')}`,
    `环境：Node ${result.env.node} / ${result.env.platform} / ${result.env.arch} / 桌面 ${result.env.desktop}`,
    `结论：${result.healthy ? '没有致命问题' : '有致命问题'}（错误 ${result.summary.err} 警告 ${result.summary.warn}）`,
    ''
  ]
  for (const c of result.checks) {
    lines.push(`[${icon[c.level] || '?'}] ${c.title}`)
    for (const l of String(c.detail || '').split('\n')) lines.push(`    ${l}`)
    if (c.more) for (const l of String(c.more).split('\n')) lines.push(`    · ${l}`)
  }
  lines.push('', '（本报告不含节点地址、订阅链接、密码等信息，可直接粘贴求助。）')
  return lines.join('\n')
}

/** 排查页上"一键修"按钮的白名单。前端传上来的 action 必须在这里面。 */
export const FIX_ACTIONS = [
  'download-core',
  'download-rulesets',
  'authorize-tun',
  'recover-tun',
  'restart-network',
  'install-desktop',
  'takeover-terminal',
  'apply'
]
