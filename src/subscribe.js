/**
 * 订阅管理：拉取、解析、增量同步节点
 */
import { importText } from './parse.js'
import { getState, save, uid, addNodes, removeNode } from './store.js'

/** 多数机场按 UA 返回不同格式，clash.meta 拿到的 YAML 兼容性最好 */
export const DEFAULT_UA = 'clash.meta/1.19.0'

/** 解析机场返回的流量信息头 */
function parseUserInfo(raw) {
  if (!raw) return null
  const out = {}
  for (const part of String(raw).split(';')) {
    const [k, v] = part.split('=').map((x) => (x || '').trim())
    if (!k) continue
    const n = Number(v)
    out[k] = Number.isFinite(n) ? n : v
  }
  if (!Object.keys(out).length) return null
  return out
}

export async function fetchSub(url, ua) {
  let u
  try {
    u = new URL(url)
  } catch {
    throw new Error('订阅地址不是合法 URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('订阅地址必须是 http/https')
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 30000)
  try {
    const res = await fetch(u, {
      headers: { 'User-Agent': ua || DEFAULT_UA },
      redirect: 'follow',
      signal: ac.signal
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return {
      text: await res.text(),
      userinfo: parseUserInfo(res.headers.get('subscription-userinfo'))
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('订阅请求超时（30 秒）')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export function listSubs() {
  return getState().subs
}

export async function addSub({ name, url, ua }) {
  const st = getState()

  let fallbackName = '订阅'
  try {
    fallbackName = new URL(url).hostname || fallbackName
  } catch {
    throw new Error('订阅地址不是合法 URL')
  }

  const sub = {
    id: uid('s'),
    name: (name || '').trim() || fallbackName,
    url: url.trim(),
    ua: (ua || '').trim() || DEFAULT_UA,
    updatedAt: null,
    count: 0,
    format: null,
    userinfo: null
  }
  st.subs.push(sub)
  save()
  try {
    const result = await updateSub(sub.id)
    return { sub, ...result }
  } catch (e) {
    // 拉取失败时保留订阅条目，用户可以改完 UA 再重试
    sub.lastError = e.message
    save()
    throw e
  }
}

/**
 * 拉取并同步。订阅里消失的节点会被移除，仍存在的保留本地端口与开关设置。
 */
export async function updateSub(id) {
  const st = getState()
  const sub = st.subs.find((x) => x.id === id)
  if (!sub) throw new Error('订阅不存在')

  const { text, userinfo } = await fetchSub(sub.url, sub.ua)
  const { nodes, errors, format } = await importText(text)
  if (!nodes.length) {
    sub.lastError = errors[0] || '未解析出任何节点'
    save()
    throw new Error('订阅解析失败：' + sub.lastError)
  }

  // 订阅中已不存在的节点要清掉，否则会越攒越多
  const alive = new Set(nodes.map((n) => n.name))
  let removed = 0
  for (const n of [...st.nodes]) {
    if (n.subId === sub.id && !alive.has(n.name)) {
      removeNode(n.id)
      removed++
    }
  }

  const { added, updated } = addNodes(nodes, sub.id)

  sub.updatedAt = Date.now()
  sub.count = nodes.length
  sub.format = format
  sub.userinfo = userinfo || sub.userinfo
  delete sub.lastError
  save()

  return { added: added.length, updated: updated.length, removed, total: nodes.length, format, errors }
}

export function removeSub(id, keepNodes = false) {
  const st = getState()
  const i = st.subs.findIndex((x) => x.id === id)
  if (i < 0) return false

  if (keepNodes) {
    // 转为手动管理的节点
    for (const n of st.nodes) if (n.subId === id) n.subId = null
  } else {
    for (const n of [...st.nodes]) if (n.subId === id) removeNode(n.id)
  }

  st.subs.splice(i, 1)
  save()
  return true
}
