/**
 * 系统代理接管（Linux / GNOME 系桌面，含 Cinnamon、Xfce+xfsettings、MATE 等走 gsettings 的环境）
 *
 * 安全约定：
 *   1. 改之前把原值原样备份到磁盘（GVariant 文本可以原样写回）
 *   2. 备份文件落盘而非只存内存 —— 本程序崩了也能还原，不至于让整机断网
 *   3. 内核退出时由 core.js 调用 restore()
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, settings } from './store.js'
import { ENV_SH, writeSnippets } from './termproxy.js'

const exec = promisify(execFile)

const BACKUP = path.join(DATA_DIR, 'sysproxy-backup.json')

/**
 * 给终端用的 export 片段。
 * 内容由 termproxy.js 生成 —— 那边还负责「接管终端代理」（往 shell 启动脚本里挂
 * 一段 source），两边必须是同一份文件、同一套变量，所以这里只是转个名字。
 */
export const ENV_FILE = ENV_SH

/** 需要备份 / 修改的 gsettings 键 */
const KEYS = [
  ['org.gnome.system.proxy', 'mode'],
  ['org.gnome.system.proxy', 'ignore-hosts'],
  ['org.gnome.system.proxy', 'use-same-proxy'],
  ['org.gnome.system.proxy.http', 'host'],
  ['org.gnome.system.proxy.http', 'port'],
  ['org.gnome.system.proxy.https', 'host'],
  ['org.gnome.system.proxy.https', 'port'],
  ['org.gnome.system.proxy.socks', 'host'],
  ['org.gnome.system.proxy.socks', 'port'],
  ['org.gnome.system.proxy.ftp', 'host'],
  ['org.gnome.system.proxy.ftp', 'port']
]

let availablePromise = null

/** gsettings 调用统一超时：DBus 卡死时 restore() 会永远挂住，
 *  面板退出钩子跟着挂住，被 systemd 硬杀后系统代理就永远指着死端口了 */
const GSETTINGS_TIMEOUT = 8000

/** gsettings 是否可用（命令存在且 schema 已安装） */
export function available() {
  if (!availablePromise) {
    availablePromise = exec('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], { timeout: GSETTINGS_TIMEOUT })
      .then(() => true)
      .catch(() => false)
  }
  return availablePromise
}

function gvStringArray(list) {
  return '[' + list.map((s) => "'" + String(s).replace(/'/g, "\\'") + "'").join(', ') + ']'
}

async function gget(schema, key) {
  const { stdout } = await exec('gsettings', ['get', schema, key], { timeout: GSETTINGS_TIMEOUT })
  return stdout.trim()
}

async function gset(schema, key, value) {
  await exec('gsettings', ['set', schema, key, value], { timeout: GSETTINGS_TIMEOUT })
}

function readBackup() {
  try {
    return JSON.parse(fs.readFileSync(BACKUP, 'utf8'))
  } catch {
    return null
  }
}

export function state() {
  const b = readBackup()
  const s = settings()
  return {
    managed: !!b,
    host: '127.0.0.1',
    port: Number(s.mainPort),
    envFile: ENV_FILE,
    since: b ? b.at : null
  }
}

/** 给终端用的 export 片段：termproxy.js 统一生成（带活性检查和 proxyon/proxyoff 开关） */
function writeEnvFile() {
  writeSnippets()
}

/** 接管系统代理，指向本机主端口 */
export async function apply() {
  if (!(await available())) {
    throw new Error('当前桌面环境不支持 gsettings，无法自动接管系统代理')
  }

  const s = settings()
  const host = '127.0.0.1'
  const port = Number(s.mainPort)
  const bypass = Array.isArray(s.bypassList) && s.bypassList.length ? s.bypassList : ['localhost', '127.0.0.0/8', '::1']

  // 已经接管过就不要覆盖备份，否则原值会丢
  if (!readBackup()) {
    const values = {}
    for (const [schema, key] of KEYS) {
      try {
        values[`${schema}::${key}`] = await gget(schema, key)
      } catch {
        // 某些环境缺少 ftp 之类的子 schema，跳过即可
      }
    }
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(BACKUP, JSON.stringify({ at: Date.now(), values }, null, 2))
  }

  // mixed 入站同时提供 HTTP 与 SOCKS，所以三者可以指同一个端口
  await gset('org.gnome.system.proxy.http', 'host', host)
  await gset('org.gnome.system.proxy.http', 'port', String(port))
  await gset('org.gnome.system.proxy.https', 'host', host)
  await gset('org.gnome.system.proxy.https', 'port', String(port))
  await gset('org.gnome.system.proxy.socks', 'host', host)
  await gset('org.gnome.system.proxy.socks', 'port', String(port))
  await gset('org.gnome.system.proxy', 'ignore-hosts', gvStringArray(bypass))
  await gset('org.gnome.system.proxy', 'use-same-proxy', 'true')
  await gset('org.gnome.system.proxy', 'mode', 'manual')

  writeEnvFile()
  return state()
}

/** 还原到接管前的状态（幂等，没备份就什么都不做） */
export async function restore() {
  const b = readBackup()
  if (!b) return state()

  if (await available()) {
    // 先把 mode 拉回去，尽快恢复联网，再慢慢还原其余键
    const mode = b.values['org.gnome.system.proxy::mode']
    if (mode) await gset('org.gnome.system.proxy', 'mode', mode).catch(() => {})

    for (const [k, v] of Object.entries(b.values)) {
      const [schema, key] = k.split('::')
      if (key === 'mode') continue
      await gset(schema, key, v).catch(() => {})
    }
  }

  // 不删除，改名保留一份原值快照，方便出问题时人工核对
  try {
    fs.renameSync(BACKUP, BACKUP.replace(/\.json$/, '.last.json'))
  } catch {
    // 改名失败也不影响：下次 apply 会覆盖备份
  }
  return state()
}

/**
 * 服务启动时调用：上次异常退出可能残留了系统代理设置，
 * 此时内核并没在跑，必须还原，否则用户整机无法联网。
 */
export async function restoreIfStale() {
  if (readBackup()) return restore()
  return state()
}
