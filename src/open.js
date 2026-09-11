/**
 * 打开本机文件管理器 —— 给面板上的【打开配置文件夹】按钮用。
 *
 * 两个现实问题：
 *
 * 1. 面板服务是 systemd --user 起的，不保证继承 DISPLAY / DBUS_SESSION_BUS_ADDRESS。
 *    缺了这些，xdg-open 会静默什么都不做。所以先检查环境，缺了就明确报错并把路径回给前端，
 *    让用户至少能复制路径 —— 比点一下没反应好得多。
 * 2. xdg-open 在不同桌面上成功率参差。挨个试：xdg-open → gio → 各家文件管理器
 *    （Mint/Cinnamon 是 nemo，所以它排在 nautilus 前面）。
 *
 * 只打开写死的数据目录，不接受任何外部传入的路径。
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const OPENERS = [
  ['xdg-open', []],
  ['gio', ['open']],
  ['nemo', []],
  ['nautilus', []],
  ['thunar', []],
  ['dolphin', []],
  ['caja', []],
  ['pcmanfm', []]
]

/** 图形会话是否可达 */
export function graphicalEnv() {
  const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY
  const bus = process.env.DBUS_SESSION_BUS_ADDRESS
  return { display: !!display, bus: !!bus, ok: !!display }
}

/**
 * 试着起一个 opener。
 * 1.2 秒内非零退出算失败（命令不存在 / 拒绝打开）；
 * 还在跑说明文件管理器起来了，算成功。
 */
function tryOpener(cmd, args, target) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, [...args, target], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      })
    } catch (e) {
      return resolve({ ok: false, error: e.message })
    }

    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      resolve(r)
    }

    child.on('error', (e) => finish({ ok: false, error: e.message }))
    child.on('exit', (code) => {
      finish(code === 0 ? { ok: true } : { ok: false, error: `退出码 ${code}` })
    })

    setTimeout(() => {
      // 还没退出：文件管理器常驻前台，这就是成功的样子
      child.unref()
      finish({ ok: true })
    }, 1200)
  })
}

/**
 * 打开一个目录。
 * @param {string} dir 绝对路径，由调用方保证是程序自己的目录
 */
export async function openDir(dir) {
  fs.mkdirSync(dir, { recursive: true })

  const env = graphicalEnv()
  if (!env.ok) {
    const e = new Error(
      '当前进程看不到图形会话（DISPLAY 未设置），无法调起文件管理器。\n' +
        `请手动打开：${dir}\n` +
        '托盘菜单里的同名菜单项不受此限制，可以改用它。'
    )
    e.path = dir
    throw e
  }

  const tried = []
  for (const [cmd, args] of OPENERS) {
    const r = await tryOpener(cmd, args, dir)
    if (r.ok) return { ok: true, via: cmd, path: dir }
    tried.push(`${cmd}(${r.error})`)
  }

  const e = new Error(`没有可用的文件管理器，已尝试：${tried.join('、')}\n请手动打开：${dir}`)
  e.path = dir
  throw e
}
