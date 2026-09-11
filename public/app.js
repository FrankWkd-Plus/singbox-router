import { nodeToUri, nodesToUris, toSubscription } from './export.js'
import { toSvg } from './qrcode.js'

const $ = (sel) => document.querySelector(sel)

let state = { settings: {}, subs: [], nodes: [], rules: [], status: {}, issues: [] }
let nodeFilter = ''
/** 正在编辑的规则 id；null 表示处于「添加」模式 */
let editingRuleId = null

// ------------------------------------------------------------------- 工具

async function api(pathname, opts = {}) {
  const res = await fetch(pathname, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw new Error(text.slice(0, 200) || `HTTP ${res.status}`)
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`)
  return data
}

let toastTimer = null
function toast(msg, kind = '') {
  const t = $('#toast')
  t.textContent = msg
  t.className = 'toast ' + kind
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'err' ? 7000 : 3200)
}

/** 用 DOM API 构建元素：节点名来自订阅，绝不能拼 innerHTML */
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v)
    else if (v === true) node.setAttribute(k, '')
    else if (v !== false && v != null) node.setAttribute(k, String(v))
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue
    node.append(typeof kid === 'string' ? document.createTextNode(kid) : kid)
  }
  return node
}

function fmtBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let x = v
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i++
  }
  return `${x.toFixed(x < 10 && i > 0 ? 2 : 0)} ${units[i]}`
}

function fmtTime(ts) {
  if (!ts) return '从未'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制：' + text, 'ok')
  } catch {
    toast('复制失败，请手动复制：' + text, 'err')
  }
}

// ------------------------------------------------------------------- 渲染

function renderStatus() {
  const st = state.status || {}
  const s = state.settings || {}

  const pill = $('#status-pill')
  pill.textContent = st.running ? `运行中 · PID ${st.pid}` : '已停止'
  pill.className = 'pill ' + (st.running ? 'on' : 'off')

  const sp = $('#sysproxy-pill')
  const managed = st.sysproxy && st.sysproxy.managed
  sp.textContent = managed ? `系统代理：已接管 :${st.sysproxy.port}` : '系统代理：未接管'
  sp.className = 'pill ' + (managed ? 'on' : 'ghost')
  $('#btn-sysproxy').textContent = managed ? '还原系统代理' : '接管系统代理'

  // TUN 状态：开着但没权限/有冲突时要显眼，否则用户会一直纳闷为什么 TG 还是不通
  const tun = st.tun
  const tunPill = $('#tun-pill')
  if (!tun || !tun.enabled) {
    tunPill.hidden = true
  } else {
    tunPill.hidden = false
    const blocked = !tun.capability.ok || (tun.conflicts || []).length || (tun.stale || []).length
    // 三态要分清：没跑起来时只是「就绪」，别让人以为已经在生效
    tunPill.textContent = blocked ? 'TUN 未就绪' : st.running ? `TUN 生效 · ${tun.interface}` : 'TUN 就绪'
    tunPill.className = 'pill ' + (blocked ? 'off' : st.running ? 'on' : 'warn')
    tunPill.title = blocked
      ? '前置条件未满足，见「设置 → TUN 全局代理」'
      : st.running
        ? `TUN 正在工作，网卡 ${tun.interface}`
        : '配置已开启，但内核未运行 —— 点「启动」后才会生效'
  }

  $('#dirty-pill').hidden = !st.dirty
  $('#btn-apply').classList.toggle('primary', !!st.dirty)

  $('#core-version').textContent = state.coreVersion
    ? state.coreVersion + (state.proxyUtils ? ' · proxy-utils 已加载' : '')
    : '未找到 sing-box 内核'

  $('#btn-start').disabled = !!st.running
  $('#btn-stop').disabled = !st.running
  $('#main-port-ref').textContent = `127.0.0.1:${s.mainPort}`

  if (state.clashMode) $('#mode-select').value = state.clashMode
  renderProxySelect()
}

/** 主端口所用节点：auto 走自动测速，也可以钉死某个节点 */
function renderProxySelect() {
  const sel = $('#proxy-select')
  const running = !!(state.status && state.status.running)
  const enabled = state.nodes.filter((n) => n.enabled)

  sel.replaceChildren(
    el('option', { value: 'auto', text: '主端口：自动选择' }),
    ...enabled.map((n) => el('option', { value: n.tag, text: '主端口：' + n.name }))
  )

  sel.disabled = !running || !enabled.length
  if (state.currentProxy) sel.value = state.currentProxy
}

function delayCell(node) {
  if (node.delay == null) return el('span', { class: 'hint', text: '—' })
  const cls = node.delay < 300 ? 'delay-good' : node.delay < 800 ? 'delay-mid' : 'delay-bad'
  return el('span', { class: cls, text: `${node.delay} ms` })
}

async function patchNode(id, body, onFail) {
  try {
    await api(`/api/nodes/${id}`, { method: 'PATCH', body })
    await refresh()
  } catch (e) {
    toast(e.message, 'err')
    if (onFail) onFail()
  }
}

// ------------------------------------------------------------------- 导出

/**
 * 二维码用 <img src="data:…"> 而不是插 innerHTML。
 * SVG 里只有数字和固定颜色（节点名不进 SVG），但走 data URI 就不必论证这一点。
 */
function qrImage(text, scale) {
  const svg = toSvg(text, { level: 'M', scale, margin: 4 })
  return el('img', {
    class: 'qr',
    src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
    alt: '节点二维码'
  })
}

/** 一段可复制的文本 + 复制按钮 */
function copyBlock(label, text, hint) {
  const area = el('textarea', { class: 'export-text', rows: '3', spellcheck: 'false', readonly: true })
  area.value = text
  area.addEventListener('focus', () => area.select())
  return el(
    'div',
    { class: 'export-block' },
    el(
      'div',
      { class: 'export-block-head' },
      el('b', { text: label }),
      el('button', { class: 'mini', text: '复制', onClick: () => copyText(text) })
    ),
    area,
    hint ? el('p', { class: 'hint', text: hint }) : null
  )
}

/** 单个节点：链接 + 二维码并排 */
function exportOne(node) {
  let uri
  try {
    uri = nodeToUri(node)
  } catch (e) {
    toast(e.message, 'err')
    return
  }

  $('#export-title').textContent = '导出节点 · ' + node.name
  $('#export-body').replaceChildren(
    el(
      'div',
      { class: 'export-one' },
      el('div', { class: 'qr-wrap' }, qrImage(uri, 5)),
      el(
        'div',
        { class: 'export-side' },
        copyBlock('分享链接', uri, '扫码或复制链接，导入任意支持该协议的客户端。')
      )
    )
  )
  $('#export-dialog').showModal()
}

/** 批量：订阅 blob（含二维码）+ 逐行链接 */
function exportMany(nodes, title) {
  const { uris, skipped } = nodesToUris(nodes)
  if (!uris.length) {
    toast(skipped.length ? '没有可导出的节点：' + skipped[0].reason : '没有可导出的节点', 'err')
    return
  }

  const sub = toSubscription(uris)
  const kids = [
    el('p', { class: 'hint', text: `共 ${uris.length} 个节点` + (skipped.length ? `，跳过 ${skipped.length} 个` : '') }),
    copyBlock('订阅内容（base64）', sub, '当作订阅内容用：存成文本文件挂到能访问的地址，或直接粘到支持粘贴订阅的客户端。'),
    copyBlock('分享链接（每行一个）', uris.join('\n'), '逐行的分享链接，粘到本面板的「导入」或别的客户端都能识别。')
  ]

  // 订阅 blob 常常超出二维码容量，那就只给文本，别报错打断
  try {
    kids.push(
      el(
        'div',
        { class: 'export-block' },
        el('div', { class: 'export-block-head' }, el('b', { text: '订阅二维码' })),
        el('div', { class: 'qr-wrap' }, qrImage(sub, 3))
      )
    )
  } catch (e) {
    kids.push(el('p', { class: 'hint', text: '节点较多，订阅二维码放不下（' + e.message + '），请用上面的文本。' }))
  }

  for (const s of skipped) {
    kids.push(el('p', { class: 'hint', text: `跳过「${s.name}」：${s.reason}` }))
  }

  $('#export-title').textContent = title
  $('#export-body').replaceChildren(...kids)
  $('#export-dialog').showModal()
}

function renderNodes() {
  const body = $('#nodes-body')
  body.replaceChildren()

  const kw = nodeFilter.trim().toLowerCase()
  const list = state.nodes.filter(
    (n) => !kw || n.name.toLowerCase().includes(kw) || (n.type || '').includes(kw) || String(n.port).includes(kw)
  )

  $('#nodes-empty').hidden = list.length > 0
  $('#nodes-table').hidden = list.length === 0
  $('#nodes-empty').textContent = state.nodes.length
    ? '没有匹配的节点'
    : '还没有节点。去「导入」或「订阅」添加。'

  for (const n of list) {
    const isDirect = n.kind === 'direct'

    const enableBox = el('input', { type: 'checkbox', ...(n.enabled ? { checked: true } : {}) })
    enableBox.addEventListener('change', () => patchNode(n.id, { enabled: enableBox.checked }))

    const nameInput = el('input', { class: 'name-input', value: n.name })
    nameInput.addEventListener('change', () =>
      patchNode(n.id, { name: nameInput.value }, () => (nameInput.value = n.name))
    )

    const portInput = el('input', { class: 'port-input', type: 'number', min: '0', max: '65535', value: String(n.port || 0) })
    portInput.addEventListener('change', () =>
      patchNode(n.id, { port: Number(portInput.value) }, () => (portInput.value = String(n.port || 0)))
    )

    const ops = [
      // 直连节点没有远端服务器，也就没有分享链接可导
      ...(isDirect ? [] : [el('button', { class: 'mini', text: '导出', onClick: () => exportOne(n) }), ' ']),
      el('button', {
        class: 'mini',
        text: '复制端口',
        onClick: () =>
          n.port ? copyText(`http://127.0.0.1:${n.port}`) : toast('该节点没有分配独立端口', 'err')
      }),
      ' ',
      el('button', {
        class: 'mini danger',
        text: '删除',
        onClick: async () => {
          if (!confirm(`删除节点「${n.name}」？`)) return
          try {
            await api(`/api/nodes/${n.id}`, { method: 'DELETE' })
            await refresh()
          } catch (e) {
            toast(e.message, 'err')
          }
        }
      })
    ]
    // 直连节点没有远端服务器，测速无意义
    if (!isDirect) {
      ops.unshift(
        el('button', {
          class: 'mini',
          text: '测速',
          onClick: async (ev) => {
            ev.target.disabled = true
            try {
              await api(`/api/nodes/${n.id}/test`, { method: 'POST' })
              await refresh()
            } catch (e) {
              toast(e.message, 'err')
            } finally {
              ev.target.disabled = false
            }
          }
        }),
        ' '
      )
    }

    body.append(
      el(
        'tr',
        { class: isDirect ? 'row-direct' : '' },
        el('td', { class: 'col-on' }, enableBox),
        el('td', { class: 'name' }, nameInput),
        el('td', {}, el('span', { class: 'type-badge' + (isDirect ? ' badge-direct' : ''), text: isDirect ? '直连' : n.type || '?' })),
        el('td', { text: isDirect ? '不经代理' : `${n.server}:${n.serverPort}` }),
        el('td', { class: 'col-port' }, portInput),
        el('td', { class: 'col-delay' }, isDirect ? el('span', { class: 'hint', text: '—' }) : delayCell(n)),
        el('td', { class: 'col-ops' }, ops)
      )
    )
  }
}

function renderSubs() {
  const wrap = $('#subs-list')
  wrap.replaceChildren()

  if (!state.subs.length) {
    wrap.append(el('p', { class: 'empty', text: '还没有订阅' }))
    return
  }

  for (const s of state.subs) {
    const meta = [`节点 ${s.count || 0}`, `格式 ${s.format || '—'}`, `更新于 ${fmtTime(s.updatedAt)}`]
    const ui = s.userinfo
    if (ui && ui.total) {
      const used = Number(ui.upload || 0) + Number(ui.download || 0)
      meta.push(`流量 ${fmtBytes(used)} / ${fmtBytes(ui.total)}`)
    }
    if (ui && ui.expire) meta.push(`到期 ${new Date(ui.expire * 1000).toLocaleDateString('zh-CN')}`)

    wrap.append(
      el(
        'div',
        { class: 'sub-item' },
        el(
          'div',
          {},
          el('div', {}, el('b', { text: s.name }), s.lastError ? el('span', { class: 'pill off', text: '拉取失败' }) : null),
          el('div', { class: 'sub-url', text: s.url }),
          el('div', { class: 'meta' }, ...meta.map((t) => el('span', { text: t }))),
          s.lastError ? el('div', { class: 'hint', text: s.lastError }) : null
        ),
        el(
          'div',
          { class: 'ops' },
          el('button', {
            class: 'mini',
            text: '更新',
            onClick: async (ev) => {
              ev.target.disabled = true
              ev.target.textContent = '更新中…'
              try {
                const r = await api(`/api/subs/${s.id}/update`, { method: 'POST' })
                toast(`更新完成：新增 ${r.added}，更新 ${r.updated}，移除 ${r.removed}`, 'ok')
                await refresh()
              } catch (e) {
                toast(e.message, 'err')
                await refresh()
              }
            }
          }),
          el('button', {
            class: 'mini danger',
            text: '删除',
            onClick: async () => {
              if (!confirm(`删除订阅「${s.name}」及其节点？`)) return
              try {
                await api(`/api/subs/${s.id}`, { method: 'DELETE' })
                await refresh()
              } catch (e) {
                toast(e.message, 'err')
              }
            }
          })
        )
      )
    )
  }
}

// ------------------------------------------------------------------- 规则

const RULE_TARGETS = { direct: '直连', proxy: '走代理', block: '拦截' }

function ruleTargetLabel(target) {
  if (RULE_TARGETS[target]) return RULE_TARGETS[target]
  const n = state.nodes.find((x) => x.id === target)
  return n ? n.name : '(节点已删除)'
}

/** 渲染「去向」下拉：内置三选一 + 所有已启用节点 */
function renderRuleTargetSelect() {
  const sel = $('#rule-target')
  const prev = sel.value
  sel.replaceChildren(
    ...Object.entries(RULE_TARGETS).map(([k, v]) => el('option', { value: k, text: v })),
    ...state.nodes
      .filter((n) => n.enabled)
      .map((n) => el('option', { value: n.id, text: '节点：' + n.name }))
  )
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev
}

/** 一条规则的匹配内容 → 分组展示（域名 / 正则 / IP / 进程…） */
function ruleValuesCell(rule) {
  const wrap = el('td', { class: 'rule-values' })
  const groups = [
    ['域名', rule.domain],
    ['域名正则', rule.domainRegex],
    ['IP', rule.ip],
    ['进程', rule.process],
    ['路径', rule.processPath],
    ['路径正则', rule.processRegex]
  ]
  for (const [label, values] of groups) {
    if (!values || !values.length) continue
    wrap.append(
      el('div', {}, el('span', { class: 'hint', text: label + ' ' }), el('code', { text: values.join('   ') }))
    )
  }
  return wrap
}

/** 把规则回填进表单（编辑模式） */
function fillRuleForm(rule) {
  $('#rule-domain').value = [
    ...(rule.domain || []),
    ...(rule.domainRegex || []).map((r) => 're:' + r)
  ].join('\n')
  $('#rule-ip').value = (rule.ip || []).join('\n')
  $('#rule-process').value = [
    ...(rule.process || []),
    ...(rule.processPath || []),
    ...(rule.processRegex || [])
  ].join('\n')
  $('#rule-note').value = rule.note || ''
  const sel = $('#rule-target')
  if ([...sel.options].some((o) => o.value === rule.target)) sel.value = rule.target
}

function resetRuleForm() {
  editingRuleId = null
  $('#rule-domain').value = ''
  $('#rule-ip').value = ''
  $('#rule-process').value = ''
  $('#rule-note').value = ''
  $('#btn-add-rule').textContent = '添加规则'
  $('#btn-cancel-edit').hidden = true
}

/** 上移 / 下移：换位后按整表顺序提交，顺序即优先级 */
async function moveRule(id, dir) {
  const ids = state.rules.map((r) => r.id)
  const i = ids.indexOf(id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= ids.length) return
  ;[ids[i], ids[j]] = [ids[j], ids[i]]
  try {
    await api('/api/rules/reorder', { method: 'POST', body: { ids } })
    await refresh()
  } catch (e) {
    toast(e.message, 'err')
  }
}

function renderRules() {
  renderRuleTargetSelect()

  const body = $('#rules-body')
  body.replaceChildren()
  const list = state.rules || []

  $('#rules-empty').hidden = list.length > 0
  $('#rules-table').hidden = list.length === 0
  $('#rules-count').textContent = list.length ? `共 ${list.length} 条，从上到下依次匹配` : ''

  list.forEach((rule, i) => {
    const enableBox = el('input', { type: 'checkbox', ...(rule.enabled ? { checked: true } : {}) })
    enableBox.addEventListener('change', async () => {
      try {
        await api(`/api/rules/${rule.id}`, { method: 'PATCH', body: { enabled: enableBox.checked } })
        await refresh()
      } catch (e) {
        toast(e.message, 'err')
      }
    })

    body.append(
      el(
        'tr',
        { class: rule.enabled ? '' : 'row-off' },
        el('td', { class: 'col-on' }, enableBox),
        ruleValuesCell(rule),
        el('td', { class: 'col-target', text: ruleTargetLabel(rule.target) }),
        el('td', { class: 'hint', text: rule.note || '' }),
        el(
          'td',
          { class: 'col-ops' },
          el('button', { class: 'mini', text: '↑', title: '上移（优先级提高）', disabled: i === 0, onClick: () => moveRule(rule.id, -1) }),
          ' ',
          el('button', { class: 'mini', text: '↓', title: '下移（优先级降低）', disabled: i === list.length - 1, onClick: () => moveRule(rule.id, 1) }),
          ' ',
          el('button', {
            class: 'mini',
            text: '编辑',
            onClick: () => {
              editingRuleId = rule.id
              fillRuleForm(rule)
              $('#btn-add-rule').textContent = '保存修改'
              $('#btn-cancel-edit').hidden = false
              $('#rule-hint').textContent = '正在编辑规则，保存后点「应用配置」生效'
            }
          }),
          ' ',
          el('button', {
            class: 'mini danger',
            text: '删除',
            onClick: async () => {
              if (!confirm('删除这条规则？')) return
              try {
                await api(`/api/rules/${rule.id}`, { method: 'DELETE' })
                if (editingRuleId === rule.id) resetRuleForm()
                await refresh()
              } catch (e) {
                toast(e.message, 'err')
              }
            }
          })
        )
      )
    )
  })
}

const SETTING_FIELDS = [
  ['mainPort', 'number'],
  ['portBase', 'number'],
  ['clashApiPort', 'number'],
  ['allowLan', 'bool'],
  ['dnsLocal', 'text'],
  ['dnsRemote', 'text'],
  ['chinaDirect', 'bool'],
  ['rulesetSource', 'text'],
  ['rulesetMirror', 'text'],
  ['rulesetUpdateInterval', 'text'],
  ['autoSetSystemProxy', 'bool'],
  ['tunEnabled', 'bool'],
  ['tunStrictRoute', 'bool'],
  ['tunInterface', 'text'],
  ['tunAddress', 'text'],
  ['tunMTU', 'number'],
  ['tunStack', 'text'],
  ['testUrl', 'text'],
  ['testTimeout', 'number'],
  ['logLevel', 'text'],
  ['corePath', 'text'],
  ['autoAssignPorts', 'bool'],
  ['autoStartCore', 'bool']
]

function renderSettings() {
  const s = state.settings
  for (const [key, kind] of SETTING_FIELDS) {
    const input = $('#set-' + key)
    if (!input) continue
    if (kind === 'bool') input.checked = !!s[key]
    else input.value = s[key] ?? ''
  }
  $('#set-bypassList').value = (s.bypassList || []).join('\n')

  const envFile = state.status && state.status.sysproxy && state.status.sysproxy.envFile
  $('#env-hint').textContent = envFile
    ? `gsettings 只影响图形程序。终端里请执行： source ${envFile}`
    : ''

  renderTunStatus()
  renderRuleSets()
  renderTermProxy()
}

/** 规则集本地状态：在不在、多大、什么时候下的，以及实际生效的来源 */
function renderRuleSets() {
  const box = $('#ruleset-status')
  if (!box) return
  const rs = state.ruleSets
  if (!rs) {
    box.replaceChildren()
    return
  }

  const rows = [
    el(
      'div',
      { class: 'hint' },
      '实际生效来源：',
      el('b', { text: rs.source === 'local' ? 'local（本地文件）' : 'remote（内核远程拉取）' }),
      rs.source === 'remote' && state.settings.rulesetSource === 'auto'
        ? '　—— 本地文件不全，auto 退回了远程'
        : null
    )
  ]
  for (const item of rs.items || []) {
    rows.push(
      el(
        'div',
        { class: item.present ? 'tun-ok' : 'tun-bad' },
        item.present
          ? `✅ ${item.file}（${item.label}）${fmtBytes(item.size)} · 更新于 ${fmtTime(item.mtime)}`
          : `❌ ${item.file}（${item.label}）未下载`
      )
    )
  }
  box.replaceChildren(...rows)
}

/** 终端代理：每个 shell 一行，挂没挂、rc 在不在、有没有残段 */
function renderTermProxy() {
  const box = $('#termproxy-status')
  if (!box) return
  const t = state.termProxy
  if (!t) {
    box.replaceChildren()
    return
  }

  const rows = []
  for (const s of t.shells || []) {
    if (s.hooked) rows.push(el('div', { class: 'tun-ok', text: `✅ ${s.shell} 已接管（${s.rc}）` }))
    else if (s.dangling) rows.push(el('div', { class: 'tun-bad', text: `❌ ${s.shell} 的接管片段残缺（${s.rc}），重新接管可修复` }))
    else if (s.exists) rows.push(el('div', { class: 'hint', text: `· ${s.shell} 未接管（${s.rc}）` }))
  }
  if (!rows.length) rows.push(el('div', { class: 'hint', text: '没找到 shell 配置文件（新装系统？开个终端让它生成后再来）' }))
  box.replaceChildren(...rows)

  // 接管状态变了，按钮文字要跟着变
  const btn = $('#btn-termproxy')
  if (btn) {
    btn.textContent = t.managed ? '取消终端代理接管' : '接管终端代理'
    btn.classList.toggle('primary', !t.managed)
  }
  const copy = $('#btn-termproxy-copy')
  if (copy) copy.hidden = !t.sourceLine
}

/** TUN 的三道前置条件：权限、无冲突、无残留。哪条不满足都直接说清楚。 */
function renderTunStatus() {
  const box = $('#tun-status')
  const t = state.status && state.status.tun
  if (!t) {
    box.replaceChildren()
    return
  }

  const rows = []
  rows.push(
    t.capability.ok
      ? el('div', { class: 'tun-ok', text: `✅ 内核已具备 CAP_NET_ADMIN（来源：${t.capability.via}）` })
      : el('div', { class: 'tun-bad', text: '❌ ' + t.capability.hint })
  )
  for (const c of t.conflicts || []) {
    rows.push(el('div', { class: 'tun-bad', text: `⚠ 冲突：${c.name} 正在运行（${c.how}），需先退出` }))
  }
  for (const s of t.stale || []) {
    rows.push(el('div', { class: 'tun-bad', text: `⚠ ${s} —— 点下方「一键恢复」清理` }))
  }
  box.replaceChildren(...rows)

  // 有残留时高亮恢复按钮，引导用户直接点它而不是去开终端
  const btn = $('#btn-tun-recover')
  if (btn) btn.classList.toggle('primary', (t.stale || []).length > 0)
}

// --------------------------------------------------------------- 排查

let doctorResult = null
let doctorTabOpened = false

const DOCTOR_LEVEL = {
  ok: { icon: '✅', cls: 'lv-ok' },
  info: { icon: 'ℹ️', cls: 'lv-info' },
  warn: { icon: '⚠️', cls: 'lv-warn' },
  err: { icon: '❌', cls: 'lv-err' }
}

/** 角标只数「用户该知道」的：err 必须修，warn 该看一眼 */
function renderDoctorBadge() {
  const badge = $('#doctor-badge')
  if (!badge) return
  if (!doctorResult) {
    badge.hidden = true
    return
  }
  const n = (doctorResult.summary.err || 0) + (doctorResult.summary.warn || 0)
  badge.textContent = n > 9 ? '9+' : String(n)
  badge.hidden = n === 0
}

function renderDoctor() {
  renderDoctorBadge()
  if (!doctorResult) return

  const { summary, healthy } = doctorResult
  $('#doctor-summary').replaceChildren(
    el(
      'div',
      { class: healthy ? 'doctor-good' : 'doctor-bad' },
      healthy
        ? `✓ 没有致命问题（正常 ${summary.ok} · 提示 ${summary.info} · 警告 ${summary.warn}）`
        : `✗ 有 ${summary.err} 个致命问题（另有警告 ${summary.warn}）`,
      el('span', { class: 'hint', text: ` · 检查于 ${new Date(doctorResult.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` })
    )
  )

  const list = $('#doctor-list')
  const items = doctorResult.checks.map((c) => {
    const lv = DOCTOR_LEVEL[c.level] || DOCTOR_LEVEL.info
    const body = [
      el('div', { class: 'doc-title' }, el('span', { text: lv.icon }), ' ', el('b', { text: c.title })),
      el('div', { class: 'doc-detail', text: c.detail || '' })
    ]
    if (c.more) body.push(el('div', { class: 'doc-more hint', text: c.more }))
    if (c.fix) {
      body.push(
        el(
          'div',
          { class: 'doc-fix' },
          el('button', {
            class: 'mini primary',
            text: c.fix.label || '修复',
            onClick: async (ev) => {
              const btn = ev.currentTarget
              btn.disabled = true
              try {
                const r = await api('/api/doctor/fix', { method: 'POST', body: { action: c.fix.action } })
                toast(r.ok === false ? `未完成：${r.error || '执行失败'}` : '已执行，正在复查…', r.ok === false ? 'err' : 'ok')
              } catch (e) {
                toast(e.message, 'err')
              } finally {
                btn.disabled = false
                runDoctor()
              }
            }
          })
        )
      )
    }
    return el('div', { class: `doctor-item ${lv.cls}` }, ...body)
  })
  list.replaceChildren(...(items.length ? items : [el('p', { class: 'empty', text: '没有检查项？' })]))

  const e = doctorResult.env || {}
  $('#doctor-env').replaceChildren(
    ...[
      ['数据目录', e.dataDir],
      ['程序目录', ''],
      ['Node.js', e.node],
      ['系统', `${e.platform} / ${e.arch}`],
      ['桌面', e.desktop],
      ['运行用户', e.root ? `${e.user}（root ⚠）` : e.user]
    ]
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => el('div', { class: 'doc-env-row' }, el('span', { class: 'hint', text: k + '：' }), el('code', { text: String(v) })))
  )
  const hint = $('#doctor-path-hint')
  if (hint) hint.textContent = state.dataDir || e.dataDir || ''
}

async function runDoctor() {
  const list = $('#doctor-list')
  if (list && !doctorResult) list.replaceChildren(el('p', { class: 'empty', text: '正在检查…' }))
  try {
    doctorResult = await api('/api/doctor')
    renderDoctor()
  } catch (e) {
    if (list) list.replaceChildren(el('p', { class: 'empty', text: '检查失败：' + e.message }))
  }
}

function render() {
  renderStatus()
  renderNodes()
  renderRules()
  renderSubs()
  renderSettings()
}

let lastStateJson = ''
async function refresh() {
  try {
    const next = await api('/api/state')
    // 状态没变就不重渲染：每 15s 一次的全表 DOM 重建是面板「莫名一顿」的来源，
    // 而绝大多数轮询的返回和上一次完全相同
    const j = JSON.stringify(next)
    if (j === lastStateJson) return
    lastStateJson = j
    state = next
    render()
  } catch (e) {
    toast('读取状态失败：' + e.message, 'err')
  }
}

// ------------------------------------------------------------- 事件绑定

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn))
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + btn.dataset.tab))
  })
})

function bindBusy(sel, fn, busyText) {
  $(sel).addEventListener('click', async (ev) => {
    const btn = ev.currentTarget
    const old = btn.textContent
    btn.disabled = true
    if (busyText) btn.textContent = busyText
    try {
      await fn()
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      btn.disabled = false
      btn.textContent = old
      await refresh()
    }
  })
}

bindBusy('#btn-start', async () => {
  await api('/api/core/start', { method: 'POST' })
  toast('内核已启动', 'ok')
}, '启动中…')

bindBusy('#btn-stop', async () => {
  await api('/api/core/stop', { method: 'POST' })
  toast('内核已停止', 'ok')
}, '停止中…')

bindBusy('#btn-apply', async () => {
  const r = await api('/api/core/apply', { method: 'POST' })
  toast(r.restarted === false ? '配置已写入（内核未运行）' : '配置已应用，内核已重启', 'ok')
}, '应用中…')

bindBusy('#btn-sysproxy', async () => {
  const on = !(state.status.sysproxy && state.status.sysproxy.managed)
  await api('/api/sysproxy', { method: 'POST', body: { on } })
  toast(on ? '已接管系统代理' : '已还原系统代理', 'ok')
})

bindBusy('#btn-test-all', async () => {
  await api('/api/nodes/test-all', { method: 'POST' })
  toast('测速完成', 'ok')
}, '测速中…')

bindBusy('#btn-reassign', async () => {
  await api('/api/nodes/reassign-ports', { method: 'POST' })
  toast('端口已按起始值重排', 'ok')
})

bindBusy('#btn-add-direct', async () => {
  const node = await api('/api/nodes/direct', { method: 'POST', body: {} })
  toast(`已添加直连节点，端口 ${node.port} —— 走这个端口的流量任何模式下都直连`, 'ok')
})

// ---- 规则表单（不用 bindBusy：它会在 finally 里恢复按钮文字，会盖掉编辑态的标签）----
$('#btn-add-rule').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget
  const body = {
    domain: $('#rule-domain').value,
    ip: $('#rule-ip').value,
    process: $('#rule-process').value,
    target: $('#rule-target').value,
    note: $('#rule-note').value.trim()
  }
  btn.disabled = true
  try {
    if (editingRuleId) {
      await api(`/api/rules/${editingRuleId}`, { method: 'PATCH', body })
      toast('规则已修改，点「应用配置」生效', 'ok')
    } else {
      await api('/api/rules', { method: 'POST', body })
      toast('规则已添加，点「应用配置」生效', 'ok')
    }
    resetRuleForm()
    $('#rule-hint').textContent = ''
  } catch (e) {
    $('#rule-hint').textContent = e.message
    toast(e.message, 'err')
  } finally {
    btn.disabled = false
    await refresh()
  }
})

$('#btn-cancel-edit').addEventListener('click', () => {
  resetRuleForm()
  $('#rule-hint').textContent = ''
})

bindBusy('#btn-tun-recover', async () => {
  if (!confirm('将停止内核并清理本项目的 TUN 残留（网卡 / 策略路由 / 路由表），需要系统授权。继续？')) return
  const r = await api('/api/tun/recover', { method: 'POST' })
  const result = $('#tun-recover-result')
  result.textContent = r.ok
    ? '✅ 恢复完成，网络应已回到直连（输出见日志）'
    : `❌ 未完成：${r.error || '授权被取消'}`
  toast(r.ok ? 'TUN 残留已清理' : '恢复未完成（授权取消或执行失败）', r.ok ? 'ok' : 'err')
}, '恢复中…')

// 首次切到「排查」页自动跑一次 —— 角标要数据，但没必要一开面板就全查
document.querySelectorAll('.tabs button').forEach((btn) => {
  if (btn.dataset.tab === 'doctor') {
    btn.addEventListener('click', () => {
      if (!doctorTabOpened) {
        doctorTabOpened = true
        runDoctor()
      }
    })
  }
})

bindBusy('#btn-doctor-run', runDoctor, '检查中…')

$('#btn-doctor-copy').addEventListener('click', async () => {
  if (!doctorResult || !doctorResult.text) return toast('还没跑过检查，先点「重新检查」', 'err')
  await copyText(doctorResult.text)
  toast('报告已复制（不含节点 / 订阅 / 密码，可直接贴出去）', 'ok')
})

bindBusy('#btn-open-config-dir', async () => {
  try {
    const r = await api('/api/open/config-dir', { method: 'POST' })
    toast(`已用 ${r.via} 打开 ${r.path}`, 'ok')
  } catch (e) {
    // 面板服务可能看不到图形会话（systemd --user 不一定带 DISPLAY），
    // 这时至少把路径塞进剪贴板，别让用户点了没反应还不知道原因
    toast(e.message, 'err')
    if (state.dataDir) await copyText(state.dataDir)
  }
}, '打开中…')

$('#btn-copy-config-dir').addEventListener('click', () => copyText(state.dataDir || ''))

bindBusy('#btn-update-rulesets', async () => {
  // 用输入框里的镜像，不必先保存设置 —— 下载失败时最想干的就是换个镜像立刻重试
  const r = await api('/api/rulesets/update', { method: 'POST', body: { mirror: $('#set-rulesetMirror').value } })
  $('#ruleset-result').textContent = r.message
  toast(r.message, r.ok ? 'ok' : 'err')
}, '下载中…')

bindBusy('#btn-termproxy', async () => {
  const t = state.termProxy || {}
  const r = await api('/api/termproxy', { method: 'POST', body: { on: !t.managed } })
  $('#termproxy-result').textContent = r.ok === false ? `未完成：${r.error || ''}` : ''
  toast(r.ok === false ? (r.error || '未完成') : t.managed ? '已取消终端代理接管' : '已接管终端代理（新开的终端生效）', r.ok === false ? 'err' : 'ok')
})

$('#btn-termproxy-copy').addEventListener('click', async () => {
  const t = state.termProxy || {}
  if (!t.sourceLine) return toast('没有可用的命令', 'err')
  await copyText(t.sourceLine)
  toast('已复制，粘到已开着的终端里执行', 'ok')
})

$('#node-filter').addEventListener('input', (ev) => {
  nodeFilter = ev.target.value
  renderNodes()
})

$('#mode-select').addEventListener('change', async (ev) => {
  try {
    await api('/api/mode', { method: 'POST', body: { mode: ev.target.value } })
    toast('已切换分流模式：' + ev.target.selectedOptions[0].textContent, 'ok')
  } catch (e) {
    toast(e.message, 'err')
  }
})

$('#proxy-select').addEventListener('change', async (ev) => {
  const name = ev.target.value
  try {
    await api('/api/proxy/select', { method: 'POST', body: { name } })
    toast('主端口已切换到：' + name, 'ok')
    await refresh()
  } catch (e) {
    toast(e.message, 'err')
    await refresh()
  }
})

bindBusy('#btn-add-sub', async () => {
  const url = $('#sub-url').value.trim()
  if (!url) throw new Error('请填写订阅地址')
  const r = await api('/api/subs', {
    method: 'POST',
    body: { url, name: $('#sub-name').value, ua: $('#sub-ua').value }
  })
  toast(`已添加：解析 ${r.total} 个节点（格式 ${r.format}）`, 'ok')
  $('#sub-url').value = ''
  $('#sub-name').value = ''
}, '拉取中…')

bindBusy('#btn-import', async () => {
  const text = $('#import-text').value
  if (!text.trim()) throw new Error('请先粘贴内容')
  const r = await api('/api/import', { method: 'POST', body: { text } })
  const msg = `识别为 ${r.format}：新增 ${r.added}，更新 ${r.updated}`
  $('#import-result').textContent = msg + (r.errors && r.errors.length ? `（${r.errors.length} 条被跳过）` : '')
  toast(msg, 'ok')
  if (r.errors && r.errors.length) console.warn('导入跳过：', r.errors)
}, '解析中…')

bindBusy('#btn-save-settings', async () => {
  const body = {}
  for (const [key, kind] of SETTING_FIELDS) {
    const input = $('#set-' + key)
    if (!input) continue
    body[key] = kind === 'bool' ? input.checked : kind === 'number' ? Number(input.value) : input.value
  }
  body.bypassList = $('#set-bypassList').value
  await api('/api/settings', { method: 'PATCH', body })
  toast('设置已保存。点「应用配置」生效。', 'ok')
})

// 不用 bindBusy：那个会在结束后 refresh()，会在弹窗开着时重画背后的列表
$('#btn-export-all').addEventListener('click', () => {
  // 跟着筛选框走：筛出来的就是用户眼下关心的那批
  const kw = nodeFilter.trim().toLowerCase()
  const list = state.nodes.filter(
    (n) => !kw || n.name.toLowerCase().includes(kw) || (n.type || '').includes(kw) || String(n.port).includes(kw)
  )
  exportMany(list, kw ? `导出筛选出的节点（${kw}）` : '导出全部节点')
})
$('#btn-close-export').addEventListener('click', () => $('#export-dialog').close())

$('#btn-view-config').addEventListener('click', async () => {
  try {
    const cfg = await api('/api/config')
    $('#config-body').textContent = JSON.stringify(cfg, null, 2)
    $('#config-dialog').showModal()
  } catch (e) {
    toast(e.message, 'err')
  }
})
$('#btn-close-config').addEventListener('click', () => $('#config-dialog').close())

// ------------------------------------------------------------------- 日志

const logBox = $('#logs')
$('#btn-clear-logs').addEventListener('click', () => logBox.replaceChildren())

function appendLog(entry) {
  const time = new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })
  const cls = entry.level === 'error' ? 'lv-error' : entry.level === 'warn' ? 'lv-warn' : entry.level === 'info' ? 'lv-info' : ''
  logBox.append(el('div', { class: cls, text: `${time}  ${entry.text}` }))
  // 上限对齐后端 LOG_MAX（800）：DOM 节点比内存对象贵得多，日志页不在前台时
  // 用户根本看不到更早的内容
  while (logBox.childElementCount > 800) logBox.firstElementChild.remove()
  if ($('#log-follow').checked) logBox.scrollTop = logBox.scrollHeight
}

function connectStream() {
  const es = new EventSource('/api/logs/stream')
  es.addEventListener('log', (ev) => appendLog(JSON.parse(ev.data)))
  es.addEventListener('status', (ev) => {
    state.status = JSON.parse(ev.data)
    renderStatus()
  })
  es.onerror = () => {
    // EventSource 会自己重连，这里只做提示
  }
}

await refresh()
connectStream()
// 轮询只为拿设置/节点/规则（内核状态有 SSE 推送）。页面不可见时停掉：
// 后台挂着的面板页签没必要每 15s 打一次 API、让后端跑一轮探测
setInterval(() => {
  if (!document.hidden) refresh()
}, 15000)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh()
})
