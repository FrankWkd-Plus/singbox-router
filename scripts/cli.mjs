#!/usr/bin/env node
/**
 * 命令行入口 —— 面板里那些按钮的等价物。
 *
 * 存在的意义只有两个：让 `npm run core` 之类的老命令继续work，以及给
 * 「面板都打不开了」的场合留一条退路。**日常使用不需要它** ——
 * 下载内核、授权 TUN、清残留、排查，面板和托盘菜单里都有按钮。
 *
 *   node scripts/cli.mjs get-core [--version 1.12.4] [--mirror https://ghfast.top/]
 *   node scripts/cli.mjs get-geoip [--mirror https://ghfast.top/]
 *   node scripts/cli.mjs setup-tun          # 一次性授权 TUN（会要密码）
 *   node scripts/cli.mjs tun-recover        # TUN 残留急救（会要密码）
 *   node scripts/cli.mjs restart-network    # 重启 NetworkManager（会要密码）
 *   node scripts/cli.mjs doctor [--json]    # 打一份排查报告
 *
 * 兼容环境变量：SB_MIRROR（下载镜像）、SB_BIN_DIR（内核装到哪）、SB_VERSION。
 */
import * as setup from '../src/setup.js'
import * as ruleset from '../src/ruleset.js'
import * as doctor from '../src/doctor.js'

const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', off: '\x1b[0m' }
const tty = process.stdout.isTTY
const paint = (c, s) => (tty ? c + s + C.off : s)

const say = (s) => console.log(s)
const step = (s) => console.log(paint(C.cyan, '==> ') + s)
const bad = (s) => console.error(paint(C.red, '错误: ') + s)

// ------------------------------------------------------------------ 参数

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq !== -1) out[a.slice(2, eq)] = a.slice(eq + 1)
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) out[a.slice(2)] = argv[++i]
      else out[a.slice(2)] = true
    } else out._.push(a)
  }
  return out
}

const USAGE = `用法：node scripts/cli.mjs <命令> [选项]

命令：
  get-core          下载 sing-box 内核        --version <号>  --mirror <前缀>  --dir <目录>
  get-geoip         下载国内分流规则集        --mirror <前缀>
  setup-tun         一次性授权 TUN（要密码）
  tun-recover       TUN 残留急救（要密码）    --interface <名>
  restart-network   重启网络服务（要密码）
  doctor            打一份排查报告            --json

以上每一项在面板和托盘菜单里都有对应按钮，正常用不到这个命令行。`

// ------------------------------------------------------------------ 各命令

async function cmdGetCore(args) {
  const r = await setup.downloadCore({
    version: args.version || process.env.SB_VERSION || '',
    mirror: args.mirror || process.env.SB_MIRROR || '',
    dir: args.dir || process.env.SB_BIN_DIR || ''
  })
  for (const s of r.steps) step(s)
  say('')
  say(paint(C.green, '✅ ') + r.message)
  if (r.needsReauthorize) {
    say('')
    say(
      paint(C.yellow, '注意: ') +
        'capability 是绑在文件上的，换了二进制就没了。用 TUN 的话再授权一次：\n' +
        '      node scripts/cli.mjs setup-tun   （或面板 → 问题排查 → 一次性授权 TUN）'
    )
  }
  return 0
}

async function cmdGetGeoip(args) {
  const r = await ruleset.download({ mirror: args.mirror || process.env.SB_MIRROR || '' })
  for (const item of r.results) {
    say(
      item.ok
        ? `  ${paint(C.green, '✓')} ${item.tag}  ${(item.size / 1024).toFixed(0)} KB`
        : `  ${paint(C.red, '✗')} ${item.tag}  ${item.error}`
    )
  }
  say('')
  say((r.ok ? paint(C.green, '✅ ') : paint(C.red, '❌ ')) + r.message)
  say(paint(C.dim, `目录：${r.dir}`))
  return r.ok ? 0 : 1
}

/** 特权类命令的统一收尾：输出已经通过 stdio 直通打出来了，这里只报结果 */
function finishPrivileged(r, what) {
  if (r.ok) {
    say('')
    say(paint(C.green, `✅ ${what}完成`))
    return 0
  }
  bad(r.error || `${what}失败`)
  if (r.reason === 'denied') say(paint(C.dim, '（授权框被取消了。想做就再跑一次。）'))
  return 1
}

async function cmdSetupTun() {
  step('给内核加 CAP_NET_ADMIN，并装 polkit 免密规则')
  say(paint(C.dim, '这一步需要管理员权限，会要一次密码。之后启停 TUN 都不再问。'))
  say('')
  const r = await setup.authorizeTun({ tty: true })
  if (r.ok) say(paint(C.dim, `内核：${r.core}`))
  return finishPrivileged(r, '授权')
}

async function cmdTunRecover(args) {
  step('清理残留的 TUN 网卡与策略路由')
  say(paint(C.dim, '只清本程序自己那一段索引，不碰别的客户端的规则。需要一次密码。'))
  say('')
  const r = await setup.recoverTun({ tty: true, interface: args.interface })
  return finishPrivileged(r, '清理')
}

async function cmdRestartNetwork() {
  step('重启 NetworkManager / systemd-networkd')
  const r = await setup.restartNetwork({ tty: true })
  return finishPrivileged(r, '重启')
}

async function cmdDoctor(args) {
  const result = await doctor.run()
  if (args.json) {
    say(JSON.stringify(result, null, 2))
    return result.healthy ? 0 : 1
  }

  const mark = {
    ok: paint(C.green, '✓'),
    info: paint(C.cyan, 'i'),
    warn: paint(C.yellow, '!'),
    err: paint(C.red, '✗')
  }
  say('')
  for (const c of result.checks) {
    say(`${mark[c.level] || '?'} ${c.title}`)
    for (const line of String(c.detail || '').split('\n')) say(paint(C.dim, '    ' + line))
    if (c.more) for (const line of String(c.more).split('\n')) say(paint(C.dim, '    · ' + line))
    if (c.fix) say('    ' + paint(C.cyan, `→ 面板「问题排查」里点「${c.fix.label}」即可修`))
  }
  say('')
  const { err, warn } = result.summary
  say(
    err
      ? paint(C.red, `❌ ${err} 项错误`) + (warn ? `，${warn} 项警告` : '')
      : warn
        ? paint(C.yellow, `⚠ ${warn} 项警告，没有致命问题`)
        : paint(C.green, '✅ 全部正常')
  )
  say('')
  say(paint(C.dim, '要一份能直接粘贴求助的报告（不含节点与订阅信息）：--json，或用面板里的「复制报告」。'))
  return err ? 1 : 0
}

// ------------------------------------------------------------------ 分发

const COMMANDS = {
  'get-core': cmdGetCore,
  'get-geoip': cmdGetGeoip,
  'setup-tun': cmdSetupTun,
  'tun-recover': cmdTunRecover,
  'restart-network': cmdRestartNetwork,
  doctor: cmdDoctor
}

const args = parseArgs(process.argv.slice(2))
const name = args._[0]

if (!name || args.help || name === 'help') {
  say(USAGE)
  process.exit(name ? 0 : 1)
}
const fn = COMMANDS[name]
if (!fn) {
  bad(`不认识的命令：${name}`)
  say('')
  say(USAGE)
  process.exit(1)
}

try {
  process.exit(await fn(args))
} catch (e) {
  bad(e.message)
  // 网络类失败最常见，顺手给出那两条实际有用的绕路
  if (/超时|fetch failed|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(e.message)) {
    say('')
    say('GitHub 不通时试试镜像或代理：')
    say(`  node scripts/cli.mjs ${name} --mirror https://ghfast.top/`)
    say(`  https_proxy=http://127.0.0.1:7890 node scripts/cli.mjs ${name}`)
  }
  process.exit(1)
}
