/**
 * 运行中的进程清单 —— 规则页「从运行中的进程选择」用（btop 式进程树的数据源）
 *
 * 纯 fs 读 /proc，零子进程 fork：
 * 面板打开选择器才调一次，不值得为此养一个 ps 子进程。
 *
 * 沙箱/容器注意：/proc 是命名空间的，在里面只能看到同命名空间的进程 ——
 * 这正好也是特性：面板服务看到的，就是它的流量会遇到的那些进程。
 */
import fs from 'node:fs'

/**
 * 解析 /proc/<pid>/stat。comm 在括号里且可含空格与括号，
 * 所以按「第一个 ( 到最后一个 )」切，不能用空格 split。
 * 形如：`1234 (some name (x)) S 1 ...`，pid=1、comm=2、ppid=4（括号后从 state 数起）。
 */
function parseStat(text) {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < 0 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  const name = text.slice(open + 1, close)
  const rest = text.slice(close + 2).split(' ') // 跳过 ") "，rest[0]=state, rest[1]=ppid
  const ppid = Number(rest[1])
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null
  return { pid, name, ppid }
}

/**
 * 全部用户态进程，按 pid 升序。
 *
 * 内核线程的判据：cmdline 为空（内核线程没有命令行）且 exe 读不出来。
 * 两个条件都满足才跳过 —— 只满足后者的还可能是别的用户起的进程，得留着。
 *
 * 单个进程读一半就退出（readdir 和 read 之间它没了）是常态，跳过即可。
 */
export function listProcesses() {
  const out = []
  let entries
  try {
    entries = fs.readdirSync('/proc')
  } catch {
    return out // 拿不到 /proc（非 Linux）就给空表，前端提示「拿不到进程列表」
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const dir = '/proc/' + entry
    try {
      const stat = parseStat(fs.readFileSync(dir + '/stat', 'utf8'))
      if (!stat) continue

      // exe 是符号链接，指向真实可执行文件。读不出（权限/已退出）为 null
      let path = null
      try {
        path = fs.readlinkSync(dir + '/exe')
      } catch {
        path = null
      }

      let cmdline = ''
      try {
        cmdline = fs.readFileSync(dir + '/cmdline', 'utf8')
      } catch {
        cmdline = ''
      }

      if (!cmdline && !path) continue // 内核线程

      out.push({ pid: stat.pid, ppid: stat.ppid, name: stat.name, path })
    } catch {
      // 进程在读到一半时退出 —— 下一次刷新自然就没了
    }
  }

  out.sort((a, b) => a.pid - b.pid)
  return out
}
