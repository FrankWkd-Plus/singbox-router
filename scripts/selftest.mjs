/**
 * 自检脚本 —— 不需要 sing-box 内核，纯验证解析与配置生成。
 *
 *   SBR_DATA_DIR=/tmp/sbr-selftest node scripts/selftest.mjs
 *
 * 分两层：
 *   单元测试  直接测自带解析器（parseYaml / parseUri / clashToOutbound），结果确定
 *   集成测试  测 importText 端到端（可能走 proxy-utils 通路），只断言关键字段
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseYaml } from '../src/yaml.js'
import { parseUri, clashToOutbound, importText, loadProxyUtils } from '../src/parse.js'
import * as store from '../src/store.js'
import { buildConfig, inboundTag, outboundFor } from '../src/config.js'
import { validateRule, toRouteRules, referencedNodeIds } from '../src/rules.js'
// 导出与二维码是纯前端模块，但不依赖 DOM，可以直接在 node 里测
import { nodeToUri, nodesToUris, toSubscription } from '../public/export.js'
import { encode as qrEncode, toSvg } from '../public/qrcode.js'

if (!process.env.SBR_DATA_DIR) {
  console.error('请设置 SBR_DATA_DIR 指向一个临时目录，避免覆盖真实状态。')
  process.exit(2)
}

// 每次从干净状态开始：上一轮（尤其是失败中断的那轮）可能把改过的设置落了盘，
// 那会让本轮断言基于错误的前提。store.load() 是惰性的，此刻搬走文件是安全的。
{
  const stateFile = path.join(path.resolve(process.env.SBR_DATA_DIR), 'state.json')
  try {
    if (fs.existsSync(stateFile)) fs.renameSync(stateFile, stateFile + '.prev')
  } catch {
    // 搬不动就算了，大不了沿用旧状态
  }
}

let pass = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (e) {
    failures.push({ name, e })
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message.split('\n')[0]}`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (e) {
    failures.push({ name, e })
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message.split('\n')[0]}`)
  }
}

// ----------------------------------------------------------------- 样本数据

const CLASH_YAML = `
port: 7890
socks-port: 7891
allow-lan: false
mode: rule

proxies:
  - name: "DMIT GreenClear USA New"
    type: vless
    server: 154.17.236.169
    port: 4184
    uuid: 90fe0c8e-c42c-4e4f-9002-bd43e98ef2ee
    network: tcp
    udp: true
    tls: true
    flow: xtls-rprx-vision
    servername: www.ebay.com
    reality-opts:
      public-key: O21XRlpg7qWyWq8od9DDrX4NZUmFcUK_3HlvoZA2Tzg
    client-fingerprint: chrome
  - name: 香港 WS # 这是注释，不该被吃进名字
    type: vmess
    server: hk.example.com
    port: 443
    uuid: 11111111-2222-3333-4444-555555555555
    alterId: 0
    cipher: auto
    tls: true
    network: ws
    ws-opts:
      path: /video?ed=2048
      headers:
        Host: hk.example.com
  -   name: 多空格缩进节点
      type: trojan
      server: tj.example.com
      port: 8443
      password: "pw#not-comment"
      skip-cert-verify: true
  - {name: 流式映射节点, type: ss, server: ss.example.com, port: 8388, cipher: aes-128-gcm, password: p4ss}

proxy-groups:
  - name: 节点选择
    type: select
    proxies:
      - "DMIT GreenClear USA New"

rules:
  - GEOIP,CN,DIRECT
  - MATCH,节点选择
`

const JS_LITERAL = `const newProxy = {
  name: "DMIT GreenClear USA New",
  type: "vless",
  server: "154.17.236.169",
  port: 4184,
  uuid: "90fe0c8e-c42c-4e4f-9002-bd43e98ef2ee",
  network: "tcp",
  udp: true,
  tls: true,
  flow: "xtls-rprx-vision",
  servername: "www.ebay.com",
  "reality-opts": {
    "public-key": "O21XRlpg7qWyWq8od9DDrX4NZUmFcUK_3HlvoZA2Tzg"
  },
  "client-fingerprint": "chrome"
};`

// ------------------------------------------------------------- YAML 单元测试

console.log('\nYAML 解析器')

test('基础标量与类型', () => {
  const d = parseYaml(CLASH_YAML)
  assert.equal(d.port, 7890)
  assert.equal(d['allow-lan'], false)
  assert.equal(d.mode, 'rule')
  assert.ok(Array.isArray(d.proxies), 'proxies 应是数组')
  assert.equal(d.proxies.length, 4)
})

test('嵌套块映射 reality-opts', () => {
  const p = parseYaml(CLASH_YAML).proxies[0]
  assert.equal(p.name, 'DMIT GreenClear USA New')
  assert.equal(p.server, '154.17.236.169', 'IP 不能被当成小数')
  assert.equal(p.port, 4184)
  assert.equal(p['reality-opts']['public-key'], 'O21XRlpg7qWyWq8od9DDrX4NZUmFcUK_3HlvoZA2Tzg')
  assert.equal(p['client-fingerprint'], 'chrome')
})

test('行内注释剥离，引号内的 # 保留', () => {
  const ps = parseYaml(CLASH_YAML).proxies
  assert.equal(ps[1].name, '香港 WS')
  assert.equal(ps[2].password, 'pw#not-comment')
})

test('多层嵌套 ws-opts.headers', () => {
  const p = parseYaml(CLASH_YAML).proxies[1]
  assert.equal(p['ws-opts'].path, '/video?ed=2048')
  assert.equal(p['ws-opts'].headers.Host, 'hk.example.com')
})

test('dash 后多空格的缩进写法', () => {
  const p = parseYaml(CLASH_YAML).proxies[2]
  assert.equal(p.name, '多空格缩进节点')
  assert.equal(p.type, 'trojan')
  assert.equal(p.port, 8443)
  assert.equal(p['skip-cert-verify'], true)
})

test('行内流式映射', () => {
  const p = parseYaml(CLASH_YAML).proxies[3]
  assert.equal(p.name, '流式映射节点')
  assert.equal(p.cipher, 'aes-128-gcm')
  assert.equal(p.port, 8388)
})

test('序列与父键同缩进', () => {
  const d = parseYaml('rules:\n- A\n- B\nother: 1')
  assert.deepEqual(d.rules, ['A', 'B'])
  assert.equal(d.other, 1)
})

// ---------------------------------------------------- Clash → sing-box 单元

console.log('\nClash → sing-box 转换')

test('vless + reality（自动补 uTLS）', () => {
  const ob = clashToOutbound(parseYaml(CLASH_YAML).proxies[0])
  assert.equal(ob.type, 'vless')
  assert.equal(ob.server_port, 4184)
  assert.equal(ob.flow, 'xtls-rprx-vision')
  assert.equal(ob.tls.enabled, true)
  assert.equal(ob.tls.server_name, 'www.ebay.com')
  assert.equal(ob.tls.reality.public_key, 'O21XRlpg7qWyWq8od9DDrX4NZUmFcUK_3HlvoZA2Tzg')
  assert.equal(ob.tls.utls.fingerprint, 'chrome', 'reality 必须带 uTLS')
})

test('vmess + ws（早期数据从 path 的 ?ed= 提取）', () => {
  const ob = clashToOutbound(parseYaml(CLASH_YAML).proxies[1])
  assert.equal(ob.type, 'vmess')
  assert.equal(ob.alter_id, 0, 'alter_id 为 0 不能被清掉')
  assert.equal(ob.transport.type, 'ws')
  assert.equal(ob.transport.path, '/video')
  assert.equal(ob.transport.max_early_data, 2048)
  assert.equal(ob.transport.headers.Host, 'hk.example.com')
})

test('trojan 默认开 TLS 并透传 insecure', () => {
  const ob = clashToOutbound(parseYaml(CLASH_YAML).proxies[2])
  assert.equal(ob.type, 'trojan')
  assert.equal(ob.password, 'pw#not-comment')
  assert.equal(ob.tls.enabled, true)
  assert.equal(ob.tls.insecure, true)
})

test('ss 字段映射 cipher → method', () => {
  const ob = clashToOutbound(parseYaml(CLASH_YAML).proxies[3])
  assert.equal(ob.type, 'shadowsocks')
  assert.equal(ob.method, 'aes-128-gcm')
  assert.equal(ob.password, 'p4ss')
})

// ------------------------------------------------------------ URI 单元测试

console.log('\nURI 分享链接解析')

test('vless reality', () => {
  const ob = parseUri(
    'vless://90fe0c8e-c42c-4e4f-9002-bd43e98ef2ee@154.17.236.169:4184?encryption=none&security=reality&sni=www.ebay.com&fp=chrome&pbk=O21XRlpg7qWyWq8od9DDrX4NZUmFcUK_3HlvoZA2Tzg&sid=ab&flow=xtls-rprx-vision&type=tcp#美国%20DMIT'
  )
  assert.equal(ob.type, 'vless')
  assert.equal(ob.tag, '美国 DMIT')
  assert.equal(ob.uuid, '90fe0c8e-c42c-4e4f-9002-bd43e98ef2ee')
  assert.equal(ob.server_port, 4184)
  assert.equal(ob.tls.reality.public_key, 'O21XRlpg7qWyWq8od9DDrX4NZUmFcUK_3HlvoZA2Tzg')
  assert.equal(ob.tls.reality.short_id, 'ab')
  assert.equal(ob.tls.utls.fingerprint, 'chrome')
})

test('vless ws + grpc transport', () => {
  const ws = parseUri('vless://uuid-1@a.com:443?security=tls&type=ws&path=%2Fpath%3Fed%3D2560&host=b.com#WS')
  assert.equal(ws.transport.type, 'ws')
  assert.equal(ws.transport.path, '/path')
  assert.equal(ws.transport.max_early_data, 2560)
  assert.equal(ws.transport.headers.Host, 'b.com')

  const grpc = parseUri('vless://uuid-1@a.com:443?security=tls&type=grpc&serviceName=mysvc#GRPC')
  assert.equal(grpc.transport.type, 'grpc')
  assert.equal(grpc.transport.service_name, 'mysvc')
})

test('vmess base64(JSON)', () => {
  const payload = Buffer.from(
    JSON.stringify({
      v: '2',
      ps: '日本节点',
      add: 'jp.example.com',
      port: '443',
      id: '11111111-2222-3333-4444-555555555555',
      aid: '0',
      scy: 'auto',
      net: 'ws',
      host: 'jp.example.com',
      path: '/ray',
      tls: 'tls'
    })
  ).toString('base64')
  const ob = parseUri('vmess://' + payload)
  assert.equal(ob.type, 'vmess')
  assert.equal(ob.tag, '日本节点')
  assert.equal(ob.server, 'jp.example.com')
  assert.equal(ob.server_port, 443)
  assert.equal(ob.transport.type, 'ws')
  assert.equal(ob.transport.path, '/ray')
  assert.equal(ob.tls.enabled, true)
})

test('ss SIP002（base64 userinfo）', () => {
  const cred = Buffer.from('aes-256-gcm:mypassword').toString('base64')
  const ob = parseUri(`ss://${cred}@ss.example.com:8388#新加坡`)
  assert.equal(ob.type, 'shadowsocks')
  assert.equal(ob.method, 'aes-256-gcm')
  assert.equal(ob.password, 'mypassword')
  assert.equal(ob.server_port, 8388)
  assert.equal(ob.tag, '新加坡')
})

test('ss 旧版整段 base64', () => {
  const whole = Buffer.from('aes-128-gcm:pw@1.2.3.4:8388').toString('base64')
  const ob = parseUri(`ss://${whole}#旧版`)
  assert.equal(ob.method, 'aes-128-gcm')
  assert.equal(ob.password, 'pw')
  assert.equal(ob.server, '1.2.3.4')
  assert.equal(ob.server_port, 8388)
})

test('trojan / hysteria2 / tuic / anytls / socks', () => {
  const tj = parseUri('trojan://pass123@tj.example.com:443?sni=tj.example.com&allowInsecure=1#TJ')
  assert.equal(tj.type, 'trojan')
  assert.equal(tj.password, 'pass123')
  assert.equal(tj.tls.insecure, true)

  const hy = parseUri('hysteria2://user:pw@hy.example.com:8443?sni=hy.example.com&obfs=salamander&obfs-password=xyz&up=50&down=200#HY2')
  assert.equal(hy.type, 'hysteria2')
  assert.equal(hy.password, 'user:pw')
  assert.equal(hy.obfs.type, 'salamander')
  assert.equal(hy.obfs.password, 'xyz')
  assert.equal(hy.up_mbps, 50)
  assert.equal(hy.down_mbps, 200)

  const tuic = parseUri('tuic://uuid-x:pw-y@tc.example.com:443?congestion_control=bbr&udp_relay_mode=native&alpn=h3#TUIC')
  assert.equal(tuic.type, 'tuic')
  assert.equal(tuic.uuid, 'uuid-x')
  assert.equal(tuic.password, 'pw-y')
  assert.equal(tuic.congestion_control, 'bbr')
  assert.deepEqual(tuic.tls.alpn, ['h3'])

  const at = parseUri('anytls://mypw@at.example.com:443?sni=at.example.com#AT')
  assert.equal(at.type, 'anytls')
  assert.equal(at.password, 'mypw')

  const sk = parseUri('socks://u:p@127.0.0.1:1080#SK')
  assert.equal(sk.type, 'socks')
  assert.equal(sk.version, '5')
  assert.equal(sk.username, 'u')
})

test('IPv6 地址', () => {
  const ob = parseUri('trojan://pw@[2001:db8::1]:443?sni=x.com#v6')
  assert.equal(ob.server, '2001:db8::1')
  assert.equal(ob.server_port, 443)
})

test('ssr 明确报错而不是静默丢弃', () => {
  assert.throws(() => parseUri('ssr://abcdef'), /ShadowsocksR/)
})

// ------------------------------------------------------- importText 集成测试

console.log('\nimportText 端到端')

await testAsync('Clash YAML', async () => {
  const r = await importText(CLASH_YAML)
  assert.equal(r.nodes.length, 4, `应解析 4 个节点，实际 ${r.nodes.length}`)
  const v = r.nodes.find((n) => n.type === 'vless')
  assert.ok(v, '应含 vless 节点')
  assert.equal(v.server, '154.17.236.169')
  assert.equal(v.serverPort, 4184)
})

await testAsync('JS 对象字面量', async () => {
  const r = await importText(JS_LITERAL)
  assert.equal(r.nodes.length, 1)
  assert.equal(r.nodes[0].type, 'vless')
  assert.equal(r.nodes[0].serverPort, 4184)
  assert.equal(r.nodes[0].outbound.tls.reality.public_key, 'O21XRlpg7qWyWq8od9DDrX4NZUmFcUK_3HlvoZA2Tzg')
})

await testAsync('sing-box JSON（outbounds 数组，跳过内置出站）', async () => {
  const cfg = JSON.stringify({
    outbounds: [
      { type: 'selector', tag: 'proxy', outbounds: ['a'] },
      { type: 'direct', tag: 'direct' },
      { type: 'trojan', tag: 'a', server: 'x.com', server_port: 443, password: 'p', tls: { enabled: true } }
    ]
  })
  const r = await importText(cfg)
  assert.equal(r.nodes.length, 1, '只应导入真实节点')
  assert.equal(r.nodes[0].name, 'a')
  assert.equal(r.nodes[0].type, 'trojan')
})

await testAsync('多行 URI 混合', async () => {
  const text = [
    'vless://uuid-a@a.com:443?security=tls&type=ws&path=/p#节点A',
    'trojan://pw@b.com:443?sni=b.com#节点B',
    'hysteria2://pw@c.com:8443?sni=c.com#节点C'
  ].join('\n')
  const r = await importText(text)
  assert.equal(r.nodes.length, 3)
  assert.deepEqual(r.nodes.map((n) => n.type).sort(), ['hysteria2', 'trojan', 'vless'])
})

await testAsync('整段 base64 订阅', async () => {
  const raw = ['vless://uuid-a@a.com:443?security=tls#A', 'trojan://pw@b.com:443?sni=b.com#B'].join('\n')
  const r = await importText(Buffer.from(raw).toString('base64'))
  assert.equal(r.nodes.length, 2)
})

await testAsync('无法识别的输入给出错误而不是抛异常', async () => {
  const r = await importText('这是一段随机文本，不是任何节点格式')
  assert.equal(r.nodes.length, 0)
  assert.ok(r.errors.length > 0, '应返回错误说明')
})

// ------------------------------------------------------------- 配置生成测试

console.log('\n配置生成（分流核心）')

const imported = await importText(CLASH_YAML)
store.addNodes(imported.nodes, null)
// 加一个虚拟直连节点，一起参与规则顺序验证
const directNode = store.addDirectNode('直连')
const nodes = store.getState().nodes

test('每个节点都分到了独立端口', () => {
  const ports = nodes.map((n) => n.port)
  assert.ok(
    ports.every((p) => p >= 20800),
    '端口应从 portBase 起'
  )
  assert.equal(new Set(ports).size, ports.length, '端口不能重复')
})

test('虚拟直连节点的形态', () => {
  assert.equal(directNode.kind, 'direct')
  assert.equal(directNode.outbound, null, '直连节点不该有自己的出站')
  assert.ok(directNode.port > 0, '必须有独立端口')
  assert.ok(directNode.enabled)
})

test('inbounds 含主端口与每节点端口（含直连节点）', () => {
  const cfg = buildConfig()
  const main = cfg.inbounds.find((i) => i.tag === 'in-main')
  assert.ok(main, '缺少主入站')
  assert.equal(main.listen_port, 7890)
  assert.equal(main.type, 'mixed')

  for (const n of nodes) {
    const ib = cfg.inbounds.find((i) => i.tag === inboundTag(n))
    assert.ok(ib, `节点 ${n.name} 缺少专属入站`)
    assert.equal(ib.listen_port, n.port)
    assert.equal(ib.listen, '127.0.0.1', '默认只监听回环')
  }
})

test('每个节点端口都直绑到对应出站', () => {
  const cfg = buildConfig()
  for (const n of nodes) {
    const want = outboundFor(n)
    const rule = cfg.route.rules.find(
      (r) => Array.isArray(r.inbound) && r.inbound.length === 1 && r.inbound[0] === inboundTag(n) && r.outbound === want
    )
    assert.ok(rule, `节点 ${n.name} 缺少直绑规则（应指向 ${want}）`)
  }
})

test('★ 直连节点的端口绑到内置 direct 出站', () => {
  const cfg = buildConfig()
  const rule = cfg.route.rules.find((r) => Array.isArray(r.inbound) && r.inbound[0] === inboundTag(directNode))
  assert.ok(rule, '直连节点缺少路由规则')
  assert.equal(rule.outbound, 'direct', '必须绑到 direct，而不是它自己的 tag')
})

test('★ 直绑规则必须排在 clash_mode 之前（全局模式不能覆盖端口绑定）', () => {
  const rules = buildConfig().route.rules
  const modeIdx = rules.findIndex((r) => r.clash_mode)
  assert.ok(modeIdx > 0, '应存在 clash_mode 规则')

  for (const n of nodes) {
    const bindIdx = rules.findIndex((r) => Array.isArray(r.inbound) && r.inbound[0] === inboundTag(n))
    assert.ok(bindIdx >= 0, `节点 ${n.name} 缺少直绑规则`)
    assert.ok(bindIdx < modeIdx, `节点 ${n.name} 的直绑排在 clash_mode 之后 —— 切全局模式会让独立端口失效`)
  }
})

test('★ 直连节点在 direct 与 global 两种模式下都保持直连', () => {
  const rules = buildConfig().route.rules
  const directIdx = rules.findIndex((r) => Array.isArray(r.inbound) && r.inbound[0] === inboundTag(directNode))
  const modeIdxs = rules.map((r, i) => (r.clash_mode ? i : -1)).filter((i) => i >= 0)
  assert.equal(modeIdxs.length, 2, '应有 direct 与 global 两条模式规则')
  for (const i of modeIdxs) {
    assert.ok(directIdx < i, '直连节点的绑定必须先于所有模式规则命中')
  }
})

test('直连节点不出现在 outbounds 与选择器里', () => {
  const cfg = buildConfig()
  assert.ok(!cfg.outbounds.some((o) => o.tag === directNode.tag), '虚拟节点不该产生出站')
  const sel = cfg.outbounds.find((o) => o.tag === 'proxy')
  assert.ok(!sel.outbounds.includes(directNode.tag), '虚拟节点不该进选择器')
  const auto = cfg.outbounds.find((o) => o.tag === 'auto')
  assert.ok(!auto.outbounds.includes(directNode.tag), '虚拟节点不该进 urltest')
})

test('outbounds 完整且 tag 唯一', () => {
  const cfg = buildConfig()
  const tags = cfg.outbounds.map((o) => o.tag)
  assert.equal(new Set(tags).size, tags.length, 'outbound tag 必须唯一')
  assert.ok(tags.includes('proxy'))
  assert.ok(tags.includes('auto'))
  assert.ok(tags.includes('direct'))
  for (const n of nodes.filter((x) => x.kind !== 'direct')) {
    assert.ok(tags.includes(n.tag), `缺少出站 ${n.tag}`)
  }

  const sel = cfg.outbounds.find((o) => o.tag === 'proxy')
  assert.ok(sel.outbounds.includes('auto'))
  assert.ok(sel.outbounds.includes('direct'), '选择器里应能整体切直连')
})

test('★ 配置完全不含 geo 规则集（不需要自动分流，也就没有启动期下载依赖）', () => {
  const cfg = buildConfig()
  assert.ok(!('rule_set' in cfg.route), 'route 不该有 rule_set 键')
  assert.ok(!cfg.route.rules.some((r) => r.rule_set), '路由规则不该引用规则集')
  assert.ok(!cfg.dns.rules.some((r) => r.rule_set), 'DNS 规则不该引用规则集')
  assert.ok(!JSON.stringify(cfg).includes('.srs'), '配置里不该出现任何 .srs 引用')
})

test('私有地址与内网域名直连，用内置判断', () => {
  const cfg = buildConfig()
  const priv = cfg.route.rules.find((r) => Array.isArray(r.domain_suffix) && r.domain_suffix.includes('.local'))
  assert.ok(priv, '应有内置私有域名规则')
  assert.equal(priv.outbound, 'direct')
  assert.ok(cfg.route.rules.some((r) => r.ip_is_private === true && r.outbound === 'direct'))
  assert.equal(cfg.route.final, 'proxy', '其余流量走所选节点')
})

test('停用的节点不进配置', () => {
  nodes[0].enabled = false
  store.save()
  const cfg = buildConfig()
  assert.ok(!cfg.outbounds.some((o) => o.tag === nodes[0].tag), '停用节点不该出现在 outbounds')
  assert.ok(!cfg.inbounds.some((i) => i.tag === inboundTag(nodes[0])), '停用节点不该有入站')
  nodes[0].enabled = true
  store.save()
})

test('停用直连节点后其端口也消失', () => {
  directNode.enabled = false
  store.save()
  const cfg = buildConfig()
  assert.ok(!cfg.inbounds.some((i) => i.tag === inboundTag(directNode)))
  assert.ok(!cfg.route.rules.some((r) => Array.isArray(r.inbound) && r.inbound[0] === inboundTag(directNode)))
  directNode.enabled = true
  store.save()
})

test('配置可被 JSON 序列化且无 undefined', () => {
  const cfg = buildConfig()
  const text = JSON.stringify(cfg)
  assert.ok(!text.includes('undefined'))
  assert.deepEqual(JSON.parse(text), cfg)
})

// ------------------------------------------------------------ 自定义分流规则

console.log('\n自定义分流规则')

const addValidRule = (input) => {
  const { rule, error } = validateRule(input, nodes)
  assert.ok(!error, `规则应通过校验：${error}`)
  return store.addRule(rule)
}

const assertRejected = (input, why) => {
  const { error } = validateRule(input, nodes)
  assert.ok(error, `应被拒绝：${why}`)
}

test('一条规则混多种输入：域名后缀 / 域名正则 / IP / 进程，全部进同一个去向', () => {
  const r = addValidRule({
    domain: 'github.com\nre:^.*\\.cn$',
    ip: '198.51.100.7\n10.0.0.0/8',
    process: 'telegram-desktop',
    target: 'proxy',
    note: '混合'
  })
  assert.deepEqual(r.domain, ['github.com'])
  assert.deepEqual(r.domainRegex, ['^.*\\.cn$'])
  assert.deepEqual(r.ip, ['198.51.100.7/32', '10.0.0.0/8'])
  assert.deepEqual(r.process, ['telegram-desktop'])

  const expanded = toRouteRules([r], nodes)
  // 4 个非空匹配字段（domain / domainRegex / ip / process）→ 4 条连续 sing-box 规则，去向一致
  assert.equal(expanded.length, 4)
  assert.ok(expanded.every((x) => x.outbound === 'proxy'))
  assert.deepEqual(expanded[0].domain_suffix, ['github.com'], '域名走 domain_suffix（含子域名），不是 domain 精确匹配')
  assert.deepEqual(expanded[1].domain_regex, ['^.*\\.cn$'])
  assert.deepEqual(expanded[2].ip_cidr, ['198.51.100.7/32', '10.0.0.0/8'])
  assert.deepEqual(expanded[3].process_name, ['telegram-desktop'])
})

test('进程栏三种写法分流到进程名 / 路径 / 路径正则', () => {
  const r = addValidRule({
    domain: '',
    ip: '',
    process: 'telegram-desktop\n/usr/bin/curl\nre:^/usr/lib/firefox/',
    target: 'direct'
  })
  assert.deepEqual(r.process, ['telegram-desktop'])
  assert.deepEqual(r.processPath, ['/usr/bin/curl'])
  assert.deepEqual(r.processRegex, ['^/usr/lib/firefox/'])

  const expanded = toRouteRules([r], nodes)
  assert.equal(expanded.length, 3)
  assert.ok(expanded[0].process_name && expanded[1].process_path && expanded[2].process_path_regex)
})

test('★ 进程栏裸正则自动识别：不用 re: 前缀也能当路径正则', () => {
  const r = addValidRule({
    domain: '',
    ip: '',
    process: '^/usr/lib/firefox/\n^.*telegram',
    target: 'proxy'
  })
  assert.deepEqual(r.processPath, [], '带正则元字符的不该进 path 精确匹配')
  assert.deepEqual(r.process, [], '也不该进 process_name')
  assert.deepEqual(r.processRegex, ['^/usr/lib/firefox/', '^.*telegram'])

  // 边界：普通路径 /usr/bin/curl 不含元字符，仍走精确路径匹配
  const r2 = addValidRule({ domain: '', ip: '', process: '/usr/bin/curl', target: 'direct' })
  assert.deepEqual(r2.processPath, ['/usr/bin/curl'])
  assert.deepEqual(r2.processRegex, [])
})

test('拦截规则生成 action:reject（1.12 起 block 出站已废弃）', () => {
  const r = addValidRule({ domain: 'ads.example.com', ip: '', process: '', target: 'block' })
  const [expanded] = toRouteRules([r], nodes)
  assert.equal(expanded.action, 'reject')
  assert.equal(expanded.outbound, undefined)
})

test('规则指向具体节点时走该节点的 tag', () => {
  const someNode = nodes.find((n) => n.kind !== 'direct')
  const r = addValidRule({ domain: 'tg.example.com', ip: '', process: '', target: someNode.id })
  const [expanded] = toRouteRules([r], nodes)
  assert.equal(expanded.outbound, someNode.tag)

  // 指向虚拟直连节点 = 直连
  const dr = addValidRule({ domain: 'lan.example.com', ip: '', process: '', target: directNode.id })
  const [dexp] = toRouteRules([dr], nodes)
  assert.equal(dexp.outbound, 'direct')
})

test('禁用的规则不进配置，重新启用后回来', () => {
  const r = addValidRule({ domain: 'off.example.com', ip: '', process: '', target: 'direct' })
  store.updateRule(r.id, { enabled: false })
  assert.equal(toRouteRules([r], nodes).length, 0)
  assert.ok(!JSON.stringify(buildConfig()).includes('off.example.com'))
  store.updateRule(r.id, { enabled: true })
  assert.equal(toRouteRules([store.findRule(r.id)], nodes).length, 1)
})

test('★ 自定义规则排在 clash_mode 之后、私有地址兜底之前', () => {
  const r = addValidRule({ domain: 'order.example.com', ip: '', process: '', target: 'direct' })
  const rules = buildConfig().route.rules
  const idxCustom = rules.findIndex((x) => x.domain_suffix && x.domain_suffix.includes('order.example.com'))
  const idxClash = rules.findIndex((x) => x.clash_mode)
  const idxPrivate = rules.findIndex((x) => x.ip_is_private === true)
  assert.ok(idxCustom >= 0, '自定义规则应出现在 route.rules')
  assert.ok(idxClash >= 0 && idxCustom > idxClash, '自定义规则应在 clash_mode 之后')
  assert.ok(idxPrivate >= 0 && idxCustom < idxPrivate, '自定义规则应在私有地址兜底之前')
})

test('★ 规则顺序即优先级：两条规则命中同一域名时，靠上的赢', () => {
  store.addRule(validateRule({ domain: 'dup.example.com', ip: '', process: '', target: 'proxy' }, nodes).rule)
  store.addRule(validateRule({ domain: 'dup.example.com', ip: '', process: '', target: 'direct' }, nodes).rule)
  const rules = buildConfig().route.rules
  const hits = rules.filter((x) => x.domain_suffix && x.domain_suffix.includes('dup.example.com'))
  assert.equal(hits.length, 2)
  assert.equal(hits[0].outbound, 'proxy', '上面的规则先匹配')
  assert.equal(hits[1].outbound, 'direct')
})

test('坏输入被明确拒绝：RE2 不支持的正则 / IP 正则 / 空规则 / 无效去向 / 坏 IP', () => {
  assertRejected({ domain: 're:(?=bad)', ip: '', process: '', target: 'proxy' }, '前向断言')
  assertRejected({ domain: 're:(?<name>a)', ip: '', process: '', target: 'proxy' }, 'JS 式命名分组')
  assertRejected({ domain: '', ip: 're:^10\\.', process: '', target: 'direct' }, 'IP 正则')
  assertRejected({ domain: '', ip: '999.1.1.1', process: '', target: 'direct' }, '坏 IP')
  assertRejected({ domain: '', ip: '10.0.0.0/33', process: '', target: 'direct' }, '掩码越界')
  assertRejected({ domain: '', ip: '', process: '', target: 'proxy' }, '空规则')
  assertRejected({ domain: 'a.com', ip: '', process: '', target: '不存在' }, '无效去向')
})

test('Go 式命名分组 (?P<name>…) 合法（JS 引擎翻译后再编译）', () => {
  const r = addValidRule({ domain: 're:^(?P<sub>[a-z]+)\\.example\\.com$', ip: '', process: '', target: 'direct' })
  assert.deepEqual(r.domainRegex, ['^(?P<sub>[a-z]+)\\.example\\.com$'])
})

test('referencedNodeIds：只有指向具体节点的规则才计入', () => {
  const someNode = nodes.find((n) => n.kind !== 'direct')
  const before = referencedNodeIds(store.getState().rules)
  assert.ok(before.has(someNode.id))
  assert.ok(!before.has('direct') && !before.has('proxy'), '内置去向不该出现')
})

test('删掉的规则立即从配置消失，reorder 改变优先级', () => {
  const a = addValidRule({ domain: 'mv-a.example.com', ip: '', process: '', target: 'direct' })
  const b = addValidRule({ domain: 'mv-b.example.com', ip: '', process: '', target: 'proxy' })
  const ids = store.getState().rules.map((r) => r.id)
  store.removeRule(a.id)
  assert.ok(!store.getState().rules.some((r) => r.id === a.id))
  // b 挪到最前
  store.reorderRules([b.id, ...ids.filter((id) => id !== b.id)])
  const rules = buildConfig().route.rules
  const firstCustom = rules.findIndex((x) => x.domain_suffix && x.domain_suffix.some((d) => d.startsWith('mv-')))
  assert.equal(rules[firstCustom].domain_suffix[0], 'mv-b.example.com')
  store.removeRule(b.id)
})

// ------------------------------------------------------------- TUN 全局代理

console.log('\nTUN 全局代理')

test('默认不生成 tun 入站', () => {
  store.settings().tunEnabled = false
  store.save()
  const cfg = buildConfig()
  assert.ok(!cfg.inbounds.some((i) => i.type === 'tun'), '未开启时不该有 tun 入站')
  assert.ok(!cfg.route.rules.some((r) => (r.inbound || []).includes('in-tun')))
})

test('开启后生成正确的 tun 入站', () => {
  const s = store.settings()
  s.tunEnabled = true
  s.tunInterface = 'sbr-tun'
  s.tunAddress = '172.19.0.1/30'
  s.tunMTU = 9000
  s.tunStack = 'mixed'
  s.tunStrictRoute = true
  store.save()

  const tun = buildConfig().inbounds.find((i) => i.type === 'tun')
  assert.ok(tun, '缺少 tun 入站')
  assert.equal(tun.tag, 'in-tun')
  assert.equal(tun.interface_name, 'sbr-tun')
  assert.deepEqual(tun.address, ['172.19.0.1/30'])
  assert.equal(tun.auto_route, true, 'auto_route 必须开，否则流量进不来')
  assert.equal(tun.strict_route, true)
  assert.equal(tun.stack, 'mixed')
  assert.equal(tun.mtu, 9000)
})

test('★ TUN 用非默认路由表索引，避免和 v2rayN 等客户端相撞', () => {
  const tun = buildConfig().inbounds.find((i) => i.type === 'tun')
  assert.equal(tun.iproute2_table_index, 2023, 'sing-box 默认是 2022，必须错开')
  assert.equal(tun.iproute2_rule_index, 9100, 'sing-box 默认是 9000，必须错开')
})

test('国外 DNS 走 DoT 而非 UDP（UDP 穿代理不可靠）', () => {
  const cfg = buildConfig()
  const remote = cfg.dns.servers.find((d) => d.tag === 'dns-remote')
  assert.equal(remote.type, 'tls', 'UDP DNS 穿代理会超时，必须用 DoT')
  assert.equal(remote.server_port, 853)
  assert.equal(remote.detour, 'proxy')

  const local = cfg.dns.servers.find((d) => d.tag === 'dns-local')
  assert.equal(local.type, 'udp', '国内 DNS 直连用 UDP 更快')
  assert.ok(!local.detour, '国内 DNS 不该走代理')
  assert.equal(cfg.route.default_domain_resolver.server, 'dns-local', 'direct 出站解析域名应走本地 DNS')
})

test('TUN 下 DNS 按端口兜底劫持', () => {
  const rules = buildConfig().route.rules
  assert.ok(
    rules.some((r) => r.port === 53 && r.action === 'hijack-dns'),
    'TUN 下需要 port:53 的确定性劫持，不能只靠嗅探'
  )
})

test('★ TUN 必须被嗅探，否则拿不到域名', () => {
  const sniff = buildConfig().route.rules.find((r) => r.action === 'sniff')
  assert.ok(sniff, '缺少嗅探规则')
  assert.ok(sniff.inbound.includes('in-tun'), 'TUN 收到的是裸 IP 包')
  assert.ok(sniff.inbound.includes('in-main'))
})

test('DNS 劫持排在所有直绑规则之前', () => {
  const rules = buildConfig().route.rules
  const dnsIdx = rules.findIndex((r) => r.action === 'hijack-dns')
  const firstBind = rules.findIndex((r) => Array.isArray(r.inbound) && r.inbound[0].startsWith('in-n'))
  assert.ok(dnsIdx >= 0, '缺少 hijack-dns')
  assert.ok(dnsIdx < firstBind, 'DNS 劫持必须最先处理')
})

test('★ 开 TUN 后，每节点端口与直连节点依然优先于 clash_mode', () => {
  const rules = buildConfig().route.rules
  const modeIdx = rules.findIndex((r) => r.clash_mode)
  for (const n of store.getState().nodes.filter((x) => x.enabled && x.port > 0)) {
    const bindIdx = rules.findIndex((r) => Array.isArray(r.inbound) && r.inbound[0] === inboundTag(n))
    assert.ok(bindIdx >= 0 && bindIdx < modeIdx, `节点 ${n.name} 的直绑被 clash_mode 抢先`)
  }
})

test('TUN 与每节点端口共存：入站数量正确', () => {
  const cfg = buildConfig()
  const perNode = store.getState().nodes.filter((n) => n.enabled && n.port > 0).length
  // in-main + in-tun + 每节点一个
  assert.equal(cfg.inbounds.length, 2 + perNode)
  store.settings().tunEnabled = false
  store.save()
})

// --------------------------------------------------------------- 节点导出

console.log('\n节点导出（URI 往返）')

/** 导出再导入，断言关键字段回到原样 */
function roundTrip(outbound, name = '测试节点') {
  const uri = nodeToUri({ name, kind: 'proxy', outbound })
  const back = parseUri(uri)
  assert.ok(back, `导出的链接解析不回来：${uri}`)
  assert.equal(back.tag, name, `备注名丢了：${uri}`)
  assert.equal(back.type, outbound.type)
  assert.equal(back.server, outbound.server)
  assert.equal(back.server_port, outbound.server_port)
  return back
}

test('vless + reality 往返', () => {
  const back = roundTrip({
    type: 'vless',
    tag: 'x',
    server: 'a.example.com',
    server_port: 443,
    uuid: '11111111-2222-3333-4444-555555555555',
    flow: 'xtls-rprx-vision',
    packet_encoding: 'xudp',
    tls: {
      enabled: true,
      server_name: 'sni.example.com',
      utls: { enabled: true, fingerprint: 'chrome' },
      reality: { enabled: true, public_key: 'PUBKEY', short_id: 'ab12' }
    }
  })
  assert.equal(back.uuid, '11111111-2222-3333-4444-555555555555')
  assert.equal(back.flow, 'xtls-rprx-vision')
  assert.equal(back.packet_encoding, 'xudp')
  assert.equal(back.tls.reality.public_key, 'PUBKEY')
  assert.equal(back.tls.reality.short_id, 'ab12')
  assert.equal(back.tls.utls.fingerprint, 'chrome')
})

test('vless + ws + early data 往返', () => {
  const back = roundTrip({
    type: 'vless',
    tag: 'x',
    server: 'b.example.com',
    server_port: 8443,
    uuid: 'uuid-ws',
    tls: { enabled: true, server_name: 's.example.com', insecure: true, alpn: ['h2', 'http/1.1'] },
    transport: {
      type: 'ws',
      path: '/ray',
      headers: { Host: 'host.example.com' },
      max_early_data: 2560,
      early_data_header_name: 'Sec-WebSocket-Protocol'
    }
  })
  assert.equal(back.transport.type, 'ws')
  assert.equal(back.transport.path, '/ray')
  assert.equal(back.transport.headers.Host, 'host.example.com')
  assert.equal(back.transport.max_early_data, 2560)
  assert.equal(back.tls.insecure, true)
  assert.deepEqual(back.tls.alpn, ['h2', 'http/1.1'])
})

test('vless + grpc 往返', () => {
  const back = roundTrip({
    type: 'vless',
    tag: 'x',
    server: 'c.example.com',
    server_port: 443,
    uuid: 'uuid-grpc',
    tls: { enabled: true },
    transport: { type: 'grpc', service_name: 'mysvc' }
  })
  assert.equal(back.transport.type, 'grpc')
  assert.equal(back.transport.service_name, 'mysvc')
})

test('vmess 往返（走 base64 JSON 形式）', () => {
  const back = roundTrip({
    type: 'vmess',
    tag: 'x',
    server: 'd.example.com',
    server_port: 12345,
    uuid: 'uuid-vmess',
    security: 'auto',
    alter_id: 4,
    tls: { enabled: true, server_name: 'v.example.com' },
    transport: { type: 'ws', path: '/vm', headers: { Host: 'h.example.com' } }
  })
  assert.equal(back.uuid, 'uuid-vmess')
  assert.equal(back.alter_id, 4)
  assert.equal(back.transport.type, 'ws')
  assert.equal(back.transport.path, '/vm')
  assert.equal(back.transport.headers.Host, 'h.example.com')
  assert.equal(back.tls.server_name, 'v.example.com')
})

test('shadowsocks 往返（含 plugin）', () => {
  const plain = roundTrip({
    type: 'shadowsocks',
    tag: 'x',
    server: 'e.example.com',
    server_port: 8388,
    method: 'aes-256-gcm',
    password: 'p@ss:word/特殊'
  })
  assert.equal(plain.method, 'aes-256-gcm')
  assert.equal(plain.password, 'p@ss:word/特殊')

  const withPlugin = roundTrip({
    type: 'shadowsocks',
    tag: 'x',
    server: 'e.example.com',
    server_port: 8388,
    method: 'chacha20-ietf-poly1305',
    password: 'pw',
    plugin: 'obfs-local',
    plugin_opts: 'obfs=tls;obfs-host=www.bing.com'
  })
  assert.equal(withPlugin.plugin, 'obfs-local')
  assert.equal(withPlugin.plugin_opts, 'obfs=tls;obfs-host=www.bing.com')
})

test('trojan / hysteria2 / hysteria / tuic / anytls / socks 往返', () => {
  const tj = roundTrip({
    type: 'trojan',
    tag: 'x',
    server: 'f.example.com',
    server_port: 443,
    password: 'trojan-pw',
    tls: { enabled: true, server_name: 't.example.com', alpn: ['h2'] }
  })
  assert.equal(tj.password, 'trojan-pw')
  assert.equal(tj.tls.server_name, 't.example.com')

  const h2 = roundTrip({
    type: 'hysteria2',
    tag: 'x',
    server: 'g.example.com',
    server_port: 8443,
    password: 'user:secret',
    obfs: { type: 'salamander', password: 'obfs-pw' },
    up_mbps: 50,
    down_mbps: 200,
    tls: { enabled: true, server_name: 'h.example.com', insecure: true }
  })
  assert.equal(h2.password, 'user:secret')
  assert.equal(h2.obfs.type, 'salamander')
  assert.equal(h2.obfs.password, 'obfs-pw')
  assert.equal(h2.up_mbps, 50)
  assert.equal(h2.down_mbps, 200)
  assert.equal(h2.tls.insecure, true)

  const h1 = roundTrip({
    type: 'hysteria',
    tag: 'x',
    server: 'i.example.com',
    server_port: 36712,
    auth_str: 'auth-token',
    up_mbps: 10,
    down_mbps: 50,
    obfs: 'obfs-str',
    tls: { enabled: true, server_name: 'peer.example.com' }
  })
  assert.equal(h1.auth_str, 'auth-token')
  assert.equal(h1.obfs, 'obfs-str')
  assert.equal(h1.up_mbps, 10)

  const tuic = roundTrip({
    type: 'tuic',
    tag: 'x',
    server: 'j.example.com',
    server_port: 443,
    uuid: 'tuic-uuid',
    password: 'tuic-pw',
    congestion_control: 'bbr',
    udp_relay_mode: 'quic',
    tls: { enabled: true, server_name: 'tu.example.com', alpn: ['h3'] }
  })
  assert.equal(tuic.uuid, 'tuic-uuid')
  assert.equal(tuic.password, 'tuic-pw')
  assert.equal(tuic.congestion_control, 'bbr')
  assert.equal(tuic.udp_relay_mode, 'quic')

  const at = roundTrip({
    type: 'anytls',
    tag: 'x',
    server: 'k.example.com',
    server_port: 8443,
    password: 'anytls-pw',
    tls: { enabled: true, server_name: 'an.example.com' }
  })
  assert.equal(at.password, 'anytls-pw')

  const sk = roundTrip({
    type: 'socks',
    tag: 'x',
    server: 'l.example.com',
    server_port: 1080,
    version: '5',
    username: 'u',
    password: 'p'
  })
  assert.equal(sk.username, 'u')
  assert.equal(sk.password, 'p')
})

test('IPv6 服务器导出后仍可解析', () => {
  const back = roundTrip({
    type: 'trojan',
    tag: 'x',
    server: '2001:db8::1',
    server_port: 443,
    password: 'pw',
    tls: { enabled: true }
  })
  assert.equal(back.server, '2001:db8::1')
})

test('备注名里的特殊字符不破坏链接', () => {
  for (const name of ['香港 01 · 家宽', 'a#b?c&d=e', '100% 高速/节点', '🚀 IPLC']) {
    const back = roundTrip(
      { type: 'trojan', tag: 'x', server: 'm.example.com', server_port: 443, password: 'pw', tls: { enabled: true } },
      name
    )
    assert.equal(back.tag, name)
  }
})

test('直连节点与未知类型给出明确错误而不是产出坏链接', () => {
  assert.throws(() => nodeToUri({ name: '直连', kind: 'direct', outbound: null }), /直连节点/)
  assert.throws(
    () => nodeToUri({ name: 'wg', kind: 'proxy', outbound: { type: 'wireguard', server: 'a', server_port: 1 } }),
    /WireGuard/
  )
  assert.throws(
    () => nodeToUri({ name: '?', kind: 'proxy', outbound: { type: 'nonesuch', server: 'a', server_port: 1 } }),
    /暂不支持/
  )
})

test('批量导出跳过不可导出的节点并如实报告', () => {
  const { uris, skipped } = nodesToUris([
    { name: 'ok', kind: 'proxy', outbound: { type: 'trojan', server: 'n.example.com', server_port: 443, password: 'pw', tls: { enabled: true } } },
    { name: '直连', kind: 'direct', outbound: null }
  ])
  assert.equal(uris.length, 1)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].name, '直连')
})

test('订阅 blob 可被 importText 直接吃回去', async () => {
  const nodes = [
    { name: 'RT-A', kind: 'proxy', outbound: { type: 'trojan', server: 'o.example.com', server_port: 443, password: 'pw', tls: { enabled: true, server_name: 'o.example.com' } } },
    { name: 'RT-B', kind: 'proxy', outbound: { type: 'hysteria2', server: 'p.example.com', server_port: 8443, password: 'pw2', tls: { enabled: true, server_name: 'p.example.com' } } }
  ]
  const { uris } = nodesToUris(nodes)
  const r = await importText(toSubscription(uris))
  assert.equal(r.nodes.length, 2)
  assert.deepEqual(
    r.nodes.map((n) => n.name).sort(),
    ['RT-A', 'RT-B']
  )
})

test('真实状态里的所有节点都能导出（或有明确理由跳过）', () => {
  const { uris, skipped } = nodesToUris(store.getState().nodes)
  for (const s of skipped) {
    // 只允许因为「本来就没有 URI 形式」而跳过
    assert.match(s.reason, /直连节点|没有通用分享链接|不是一个真实节点/, `节点 ${s.name} 因意外原因跳过：${s.reason}`)
  }
  for (const u of uris) assert.ok(parseUri(u), `导出的链接无法回读：${u}`)
})

console.log('\n二维码编码')

test('矩阵尺寸与容量随内容增长', () => {
  // 版本 v 的边长恒为 4v+17
  for (const [text, level] of [['hello', 'M'], ['x'.repeat(200), 'M'], ['x'.repeat(200), 'H']]) {
    const m = qrEncode(text, { level })
    assert.equal(m.length, m[0].length)
    assert.equal((m.length - 17) % 4, 0)
    for (const row of m) for (const v of row) assert.equal(typeof v, 'boolean')
  }
  assert.ok(qrEncode('x'.repeat(200), { level: 'H' }).length > qrEncode('x'.repeat(200), { level: 'M' }).length)
})

test('三个定位图案就位', () => {
  const m = qrEncode('finder', { level: 'M' })
  const n = m.length
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    assert.equal(m[r0][c0], true)
    assert.equal(m[r0 + 1][c0 + 1], false)
    assert.equal(m[r0 + 3][c0 + 3], true)
  }
  // 左下定位图案上方那个固定暗模块
  assert.equal(m[n - 8][8], true)
})

test('格式信息两处一致且自洽', () => {
  const m = qrEncode('format', { level: 'Q' })
  const n = m.length
  let a = 0
  for (let i = 0; i <= 5; i++) if (m[i][8]) a |= 1 << i
  if (m[7][8]) a |= 1 << 6
  if (m[8][8]) a |= 1 << 7
  for (let i = 8; i <= 14; i++) if (m[n - 15 + i][8]) a |= 1 << i

  let b = 0
  for (let i = 0; i <= 7; i++) if (m[8][n - 1 - i]) b |= 1 << i
  if (m[8][7]) b |= 1 << 8
  for (let i = 9; i <= 14; i++) if (m[8][14 - i]) b |= 1 << i

  assert.equal(a, b, '两份格式信息不一致')
  // 解掩码后高 5 位是「纠错级别 + 掩码号」，Q 级的两位是 0b11
  const raw = (a ^ 0x5412) >>> 10
  assert.equal((raw >> 3) & 0b11, 0b11)
  assert.ok(((raw & 0b111) >= 0) && ((raw & 0b111) <= 7))
})

test('超出容量时明确报错', () => {
  assert.throws(() => qrEncode('x'.repeat(4000), { level: 'H' }), /过长/)
})

test('SVG 输出可直接渲染', () => {
  const svg = toSvg('vless://uuid@a.example.com:443#节点', { level: 'M', scale: 4, margin: 4 })
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /<path d="M/)
  assert.match(svg, /<\/svg>$/)
  // 尺寸 = (模块数 + 静默区*2) * scale
  const size = qrEncode('vless://uuid@a.example.com:443#节点', { level: 'M' }).length
  assert.match(svg, new RegExp(`width="${(size + 8) * 4}"`))
})

// ------------------------------------------------------------------- 汇总

const pu = await loadProxyUtils()
console.log(`\nproxy-utils：${pu ? '已加载 ' + pu.path : '未找到（走自带解析器）'}`)
console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项\n`)

if (failures.length) {
  for (const f of failures) {
    console.error(`\x1b[31m✗ ${f.name}\x1b[0m`)
    console.error(f.e.stack.split('\n').slice(0, 4).join('\n'), '\n')
  }
  process.exit(1)
}
