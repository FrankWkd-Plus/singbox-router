/**
 * GeoIP / GeoSite 规则集（.srs）管理
 *
 * 「国内自动分流」需要两份二进制规则集。它们不进仓库（几 MB，且需要定期更新），
 * 而是下载到数据目录的 rulesets/ 下。
 *
 * 早先的版本让内核自己远程拉，结果**从来没成功过** —— 启动 0.03 秒、
 * 日志里没有任何 rule-set 行、cache.db 一直是空的，开关等于没接线。
 * 这次改成**本地文件优先**：先下好、能看到文件大小和时间，再生成引用它的配置。
 * 远程模式仍然保留（rulesetSource=remote），但它是明确的选择，不是默认的沉默行为。
 */
import fs from 'node:fs'
import path from 'node:path'
import { RULESET_DIR, settings } from './store.js'

/** rule-set 分支上的 .srs 是官方持续构建产物，比 releases 资产稳定好引用 */
const BASE = {
  geoip: 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set',
  geosite: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set'
}

/** 国内直连需要的两份规则集 */
export const RULESETS = [
  {
    tag: 'geoip-cn',
    file: 'geoip-cn.srs',
    url: `${BASE.geoip}/geoip-cn.srs`,
    label: '中国大陆 IP 段'
  },
  {
    tag: 'geosite-cn',
    file: 'geosite-cn.srs',
    url: `${BASE.geosite}/geosite-cn.srs`,
    label: '中国大陆域名'
  }
]

export function rulesetPath(file) {
  return path.join(RULESET_DIR, file)
}

/** 加镜像前缀。和 get-core.sh 的 SB_MIRROR 用法一致：整条 URL 拼在后面。 */
export function mirrored(url, mirror) {
  const m = String(mirror || '').trim()
  if (!m) return url
  return m.endsWith('/') ? m + url : m + '/' + url
}

/** 每份规则集的本地状态：在不在、多大、什么时候下的 */
export function status() {
  return RULESETS.map((rs) => {
    const p = rulesetPath(rs.file)
    let stat = null
    try {
      stat = fs.statSync(p)
    } catch {
      /* 不存在 */
    }
    return {
      tag: rs.tag,
      file: rs.file,
      label: rs.label,
      path: p,
      present: !!stat,
      size: stat ? stat.size : 0,
      mtime: stat ? stat.mtimeMs : null
    }
  })
}

/** 两份都在才算齐；缺一份就不能用 local 模式 */
export function allPresent() {
  return status().every((s) => s.present)
}

/**
 * 实际生效的来源。
 * auto 的语义：本地齐了用本地，没齐就退回远程 —— 用户不必先手动下一遍才能开开关。
 */
export function effectiveSource() {
  const want = settings().rulesetSource || 'auto'
  if (want === 'local' || want === 'remote') return want
  return allPresent() ? 'local' : 'remote'
}

/** .srs 是二进制格式，头部是固定魔数，用它挡住下到 HTML 错误页的情况 */
const SRS_MAGIC = Buffer.from('SRS', 'ascii')

function looksLikeSrs(buf) {
  return buf.length > 8 && buf.subarray(0, 3).equals(SRS_MAGIC)
}

/**
 * 下载全部规则集。先落临时文件再 rename，中途失败不会留下半个文件。
 * @param {{mirror?: string, timeout?: number}} opts
 */
export async function download(opts = {}) {
  const mirror = opts.mirror ?? settings().rulesetMirror
  const timeout = opts.timeout ?? 60000
  fs.mkdirSync(RULESET_DIR, { recursive: true })

  const results = []
  for (const rs of RULESETS) {
    const url = mirrored(rs.url, mirror)
    const dest = rulesetPath(rs.file)
    const tmp = dest + '.tmp'
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      let buf
      try {
        const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        buf = Buffer.from(await res.arrayBuffer())
      } finally {
        clearTimeout(timer)
      }
      if (!looksLikeSrs(buf)) {
        throw new Error(`返回的不是 .srs 文件（${buf.length} 字节，可能是错误页或被拦截）`)
      }
      fs.writeFileSync(tmp, buf)
      fs.renameSync(tmp, dest)
      results.push({ tag: rs.tag, ok: true, size: buf.length, url })
    } catch (e) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
      } catch {
        /* 清不掉就算了，下次覆盖 */
      }
      results.push({ tag: rs.tag, ok: false, error: e.message, url })
    }
  }

  const failed = results.filter((r) => !r.ok)
  return {
    ok: failed.length === 0,
    results,
    dir: RULESET_DIR,
    message: failed.length
      ? `${results.length - failed.length}/${results.length} 成功；失败：` +
        failed.map((f) => `${f.tag}(${f.error})`).join('、') +
        '。被墙可以换镜像：设置里的「规则集镜像」填 https://ghfast.top/'
      : `${results.length} 份规则集已更新`
  }
}

/**
 * 生成 route.rule_set 配置段。
 * @returns {{ruleSets: Array, source: string, missing: Array<string>}}
 */
export function buildRuleSets() {
  const s = settings()
  const source = effectiveSource()
  const missing = []
  const ruleSets = []

  for (const rs of RULESETS) {
    if (source === 'local') {
      const p = rulesetPath(rs.file)
      if (!fs.existsSync(p)) missing.push(rs.file)
      ruleSets.push({ type: 'local', tag: rs.tag, format: 'binary', path: p })
    } else {
      ruleSets.push({
        type: 'remote',
        tag: rs.tag,
        format: 'binary',
        url: mirrored(rs.url, s.rulesetMirror),
        // 经代理下载：规则集本身在墙外，直连大概率拿不到 ——
        // 这正是上个版本「静默失败」的根因
        download_detour: 'proxy',
        update_interval: s.rulesetUpdateInterval || '7d'
      })
    }
  }

  return { ruleSets, source, missing }
}
