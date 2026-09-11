# singbox-router

基于 sing-box 的分流 Web 客户端。三件事：**订阅 / 多格式节点导入**、**接管系统代理**、**给每个节点分配独立本地端口以实现分流**。

零 npm 依赖，纯 Node stdlib + 一个单页面板。

---

## 分流是怎么做的

这是本项目的核心。生成的 sing-box 配置里有两类入站：

| 入站 | 端口 | 行为 |
| --- | --- | --- |
| `in-main` | `7890`（可改） | 走 `proxy` 选择器（所选节点 / auto / direct） |
| `in-tun` | 网卡 `sbr-tun` | 同上，但透明捕获全部程序 |
| `in-<节点id>` | 每节点一个，默认从 `20800` 起 | **直绑该节点**，流量固定从这个节点出去 |
| `in-<直连节点id>` | 虚拟【直连】节点 | **直绑内置 `direct`**，任何模式下都不经代理 |

不做自动分流（不使用 geo 规则集），所以没有任何启动期下载依赖。
只有私有地址和 `.local` 这类内网域名内置直连。

路由规则里，节点直绑规则排在 **`clash_mode` 和所有通用规则之前**——sing-box 路由「首个匹配生效」，
这个顺序保证两件事：走独立端口的流量不会被通用规则截走，**也不会被全局/直连模式的下拉框静默推翻**
（独立端口是你显式指定的，模式开关只应影响全局流量）：

```jsonc
"route": {
  "rules": [
    { "inbound": ["in-main", "in-tun"], "action": "sniff" },
    { "protocol": "dns", "action": "hijack-dns" },
    { "port": 53, "action": "hijack-dns" },

    // ★ 节点直绑：谁连这个端口，就从这个节点出去
    { "inbound": ["in-n_a1b2c3"], "outbound": "香港 01" },
    { "inbound": ["in-n_d4e5f6"], "outbound": "日本 02" },
    // ★ 虚拟直连节点：绑内置 direct
    { "inbound": ["in-d_704acb"], "outbound": "direct" },

    // 以下只对主端口 / TUN 生效
    { "clash_mode": "direct", "outbound": "direct" },
    { "clash_mode": "global", "outbound": "proxy" },

    // ★ 自定义分流规则（面板「规则」页，从上到下优先）
    { "domain_suffix": ["github.com"], "outbound": "proxy" },
    { "ip_cidr": ["10.0.0.0/8"], "outbound": "direct" },
    { "process_path_regex": ["^/usr/lib/firefox/"], "outbound": "香港 01" },
    { "domain_suffix": ["ads.example.com"], "action": "reject" },

    { "domain_suffix": [".local", ".lan", "…"], "outbound": "direct" },
    { "ip_is_private": true, "outbound": "direct" }
  ],
  "final": "proxy"
}
```

### 自定义分流规则

面板「规则」页，一条规则 = **域名 / IP / 进程的任意组合 → 同一个去向**（直连 / 走代理 / 拦截 / 某个节点），
命中其中任意一项就进这个去向。规则**从上到下**依次匹配，上面的优先，可以 ↑↓ 调整。

| 栏 | 写法 | 说明 |
| --- | --- | --- |
| 域名 | `github.com` | 后缀匹配，含所有子域名；粘贴整条 URL 会自动剥掉协议和路径 |
| 域名 | `re:^.*\.cn$` | `re:` 前缀 = 正则（Go RE2） |
| IP | `198.51.100.7` · `10.0.0.0/8` | 裸 IP 自动补 /32 或 /128；sing-box 的 IP 匹配走前缀树，**没有 IP 正则** |
| 进程 | `telegram-desktop` | 按进程名匹配 |
| 进程 | `/usr/bin/curl` | 以 `/` 开头 = 按完整路径匹配 |
| 进程 | `re:^/usr/lib/firefox/` | 路径正则 |

正则按 Go RE2 语法校验（不支持前后向断言、反向引用；命名分组写 `(?P<name>…)`），
保存时就拦下写法问题，而不是等内核启动报错。
进程匹配对 TUN 和本地代理端口（系统代理）都有效——但走**独立节点端口**的流量被端口直绑规则优先截走，不经过自定义规则。

整体优先级：**端口直绑 → 模式开关 → 自定义规则 → 私有地址 → 默认走代理**。

### 虚拟【直连】节点

点节点页的「+ 直连节点」加一个。它没有远端服务器，只占一个本地端口，
**走这个端口的流量在任何模式下都直连**——用来给个别程序开后门，比国内直连规则精确得多：

```bash
# 假设它分到 20807
curl -x http://127.0.0.1:20807 https://ip.sb     # 显示你的真实 ISP 出口
git config --global http.proxy http://127.0.0.1:20807   # git 走直连，其余走代理
```

它不会出现在 `outbounds`、`proxy` 选择器和 `auto` 测速里，也没有延迟测试（测它没意义）。

### 实际用法

```bash
# 假设面板给「日本 02」分了 20803
curl -x http://127.0.0.1:20803 https://ip.sb          # 从日本出

# 不同工具绑不同节点，互不干扰
git  config --global http.proxy http://127.0.0.1:20801
npm  config set proxy            http://127.0.0.1:20802
export https_proxy=http://127.0.0.1:20803             # 当前 shell 走日本
```

每个端口都是 `mixed` 入站，**HTTP 和 SOCKS5 共用同一端口**，所以 `socks5://127.0.0.1:20803` 同样可用。

---

## 安装

需要 **Node >= 20** 和 **sing-box >= 1.12**（配置用的是 1.12 的 schema：新版 DNS server 格式、`action` 字段；1.12 以下会因未知字段启动失败。实测 1.13.18 可用）。

```bash
cd ~/singbox-router

# 1. 下载内核到 ./bin/sing-box
bash scripts/get-core.sh
#    GitHub 不通时：
#    SB_MIRROR=https://ghfast.top/ bash scripts/get-core.sh
#    https_proxy=http://127.0.0.1:10814 bash scripts/get-core.sh
#    也可以直接在面板「设置 → 内核路径」填一个已有的 sing-box

# 2. 启动面板
node server.js
```

打开 http://127.0.0.1:8899 → 导入节点 → 点「启动」。

---

## 支持导入的格式

面板「导入」页粘贴即可，自动识别：

- **订阅 base64**（整段 base64 的分享链接列表）
- **分享链接**，可多行混合：`vless://` `vmess://` `ss://` `trojan://` `hysteria2://` `hy2://` `hysteria://` `tuic://` `anytls://` `socks://`
- **Clash / mihomo YAML**（含 `proxies:` 的配置，内置精简 YAML 解析器）
- **sing-box JSON**（出站数组，或含 `outbounds` 的完整配置）
- **单个 JS 对象字面量**，形如 `const newProxy = { name: "...", type: "vless", ... }`

解析走两条独立通路，互为兜底：

1. **proxy-utils**（[Sub-Store](https://github.com/sub-store-org/Sub-Store) 的解析库）——覆盖面最广，存在就优先用。会自动探测：
   - `./vendor/proxy-utils.esm.mjs`
   - `~/data/third/node-convert/proxy-utils.esm.mjs`（GUI.for.SingBox 装过「节点转换」插件就有）
2. **内置解析器** —— 上面那些格式都自己实现了一遍，proxy-utils 缺失或报错时接管

面板顶栏会显示 proxy-utils 是否已加载。

订阅按 UA 拉取，默认 `clash.meta/1.19.0`（拿 Clash YAML 兼容性最好）；拿不到节点时可以在订阅设置里换成 `sing-box` 或 `v2rayN` 重试。订阅更新是增量的：消失的节点会被移除，仍在的**保留你分配的端口和开关**。

---

## 系统代理接管

Linux 桌面走 `gsettings`（Cinnamon / GNOME / MATE / Xfce 等）。点「接管系统代理」或在设置里开自动接管，会把 http/https/socks 三项都指向主端口。

三条安全约定：

1. **改之前把原值原样备份到磁盘**（`data/sysproxy-backup.json`），不是只存内存
2. **内核意外退出会自动还原**，不会让机器留在「代理指向一个已死端口」的断网状态
3. **面板进程启动时检查残留备份**并自动还原——上次异常退出也能救回来

`gsettings` 管不到命令行程序，所以接管时会生成一份 export 片段：

```bash
source ~/singbox-router/data/proxy-env.sh
```

### 哪些程序不认系统代理

系统代理只对「主动读取它」的程序有效。实测：

| 程序 | 认系统代理 | 怎么办 |
| --- | --- | --- |
| Chrome / Firefox | ✅ | 无需额外配置 |
| **Telegram Desktop** | ❌ | 设置 → 高级 → 连接类型 → 自定义代理 → SOCKS5 `127.0.0.1:7890`（或填某节点独立端口，把 TG 钉死在该节点） |
| curl / git / npm | ❌ | `source data/proxy-env.sh`，或各自配 proxy |
| 其它 GUI 程序 | 不一定 | 用下面的 TUN 模式一网打尽 |

---

## TUN 全局代理

要让**所有**程序（含上面那些不认系统代理的）自动走代理，就开 TUN。

```bash
# 一次性授权（capability + polkit 免密，之后启停都不需要密码）
bash scripts/setup-tun.sh
```

然后在面板「设置 → TUN 全局代理」勾选启用 → 应用配置 → 启动。

这个脚本做两件事：

1. **`setcap cap_net_admin,cap_net_raw`** —— 让内核能建网卡、改路由表，而不必整个进程跑 root。
   只给这一个二进制、只给这两项能力。
2. **装一条 polkit 规则** —— TUN 起来后 sing-box 会调 `resolvectl` 配置该网卡的 DNS，
   走的是 systemd-resolved 的 D-Bus 接口，**需要 polkit 授权，跟 CAP_NET_ADMIN 无关**。
   不处理的话每次启动弹 3 次密码框（`set-domains` / `set-default-route` / `set-dns-servers`），
   停止时还有 1 次（`revert`）。规则只对当前用户放行这四个动作，
   装在 `/etc/polkit-1/rules.d/50-singbox-router.rules`，删掉即恢复默认。

（重新下载内核会覆盖二进制、capability 丢失，需再跑一次 `setup-tun.sh`。）

### 三道启动前置检查

TUN 配错会直接导致整机断网，所以这三项任一不满足都拦在启动前，并给出具体修复命令：

1. **权限** —— 内核有没有 `CAP_NET_ADMIN`（或以 root 运行）
2. **冲突** —— 有没有别的全局代理在跑。自动识别 **v2rayA**（iptables/tproxy）、**v2rayN**（sing-box TUN）、Clash/Mihomo。
   它们和 TUN 会互相抢路由，必须先退出
3. **残留** —— 上次是不是被 `kill -9` 过，留下了指向已消失网卡的策略路由

开启 TUN 时会自动跳过系统代理接管（TUN 已经全局捕获，再加一层只会让人误判问题出在哪）。

### 刻意错开路由表索引

sing-box 的 `auto_route` 默认用**路由表 2022、规则段 9000**。v2rayN 等其它 sing-box 客户端用的正是这套默认值，
两边同时开会互相覆盖对方的策略路由——现象是 v2rayN 的核心被打断、反复弹 sudo 授权框，DNS 也跟着崩。

所以本项目**刻意错开**：

| | 网卡 | 路由表 | 规则段 |
| --- | --- | --- | --- |
| v2rayN / 其它 sing-box 客户端（默认值） | `singbox_tun` | 2022 | 9000 |
| **本项目** | `sbr-tun` | **2023** | **9100** |

带来两个好处：内核层面不再互相覆盖；`tun-recover.sh` 只清理 9100 段和表 2023，**绝不会拆掉别人正在工作的 TUN**。
残留检测同理，只认我们自己的网卡名和索引段，不会把 v2rayN 的活动规则误判成我们的残留。

（逻辑上两个全局代理仍然不能同时生效，这由上面的冲突检查拦住。）

### DNS 为什么国外走 DoT

| | 协议 | 走向 |
| --- | --- | --- |
| 国内域名 | UDP `223.5.5.5` | 直连，快 |
| 国外域名 | **DoT（TLS/853）** `8.8.8.8` | 经 `proxy` 出站 |

国外 DNS 不用 UDP：UDP DNS 穿代理依赖出站的 UDP 转发能力，很多节点上会超时或丢包，
表现就是「网页能连但域名解析不了」这类 DNS 错误。DoT 基于 TCP，任何代理都能稳定承载。

TUN 模式下还额外加一条 `port: 53` 的确定性劫持——`protocol: dns` 依赖嗅探结果，
两条一起才能保证 DNS 一定被接管，不会漏到系统解析器去超时。

### 万一断网了

内核被 `kill -9`、OOM 或机器硬崩时，sing-box 没机会清理 `auto_route` 装的策略路由，
它们会指向一块已不存在的网卡——表现就是整机断网。正常 SIGTERM 停止不会有这问题。

```bash
sudo bash scripts/tun-recover.sh
```

拆掉 9100 段策略路由、清空路由表 2023、删除 `sbr-tun` 网卡，最后自动 ping 网关确认恢复。
**只动本项目的资源**，发现其它客户端的 TUN 只提示不擅自处理。

### TUN 与每节点端口共存

两者互不干扰，可以同时用：

- **TUN** 捕获全局流量 → 走 `proxy` 选择器（所选节点）
- **每节点独立端口** 依然是显式代理入口 → 指向它的程序固定走那个节点
- **虚拟【直连】节点** 的端口照样直连

自检里有专门几条断言，确认开 TUN 后节点直绑与直连节点仍然优先于 `clash_mode`。

---

## 装成桌面应用

```bash
bash scripts/install-app.sh     # 不需要 root
```

**不用 Chromium 也不用 Electron。** 面板窗口走 WebKitGTK，渲染的是同一套 web UI，
外观一行不改，但常驻内存从 910MB 降到 182MB。

| 组成 | 进程 | 说明 |
| --- | --- | --- |
| **面板后端** | `node server.js` | systemd 用户服务托管，登录自启 |
| **托盘** | `app/gui.py` | 常驻遥控器，**刻意不 import WebKit** |
| **面板窗口** | `app/window.py` | 独立进程，按需启动，关窗即退出 |
| 开始菜单入口 | — | 单实例：已在跑就激活窗口，不会冒出第二个托盘 |

### 内存：实测数字

```
                        平时常驻    打开面板时
托盘 (python)              50 MB       50 MB
node 后端                  76 MB       76 MB
sing-box 内核              56 MB       56 MB
面板窗口 (python+WebKit)     —        159 MB
WebKit 渲染进程              —        208 MB
WebKit 网络进程              —         52 MB
────────────────────────────────────────────
合计                      182 MB      601 MB
Chrome 方案(之前)          910 MB      910 MB
```

**平时常驻省 80%。** 打开面板那几分钟才涨上去，关掉立刻回落 —— 这正是把窗口拆成
独立进程的原因：WebKit 的库一旦 import 进来就常驻约 160MB，即使销毁 webview 也不释放，
而托盘要 7×24 挂着，不能背这个包袱。拆开后关窗是整进程退出，内存一分不留。
（顺带避开了 WebKit 用 SIGUSR1 做 GC、与托盘开窗信号相撞的问题。）

WebKit 还按「只渲染一个本地页面」做了裁剪：无 GPU 合成、无 WebGL / 媒体 / WebAudio、
无磁盘缓存（ephemeral context + DOCUMENT_VIEWER 档位）。node 那边也收紧了 V8：
`--max-old-space-size=96 --max-semi-space-size=2`（后者对 RSS 影响最明显，
默认是 16MB × 3 个半空间）。

> 注意 systemd 的 `Environment=` 按空格拆分，多参数必须整体加引号，
> 否则第二个参数会被静默丢掉。

### 形态取舍

代理客户端的自然形态是**后台服务 + 托盘**，而不是「一个窗口」：

- **关掉面板窗口、甚至退出托盘，都不会断网** —— 内核由服务托管，只有点「停止内核」或
  `systemctl --user stop` 才会停
- 托盘只是遥控器，所有操作都走面板的本地 HTTP API，它自己不碰 sing-box
- 日常操作托盘全包了：启停内核 / 切主端口节点 / 切分流模式 / 复制直连端口。
  只有改端口、导入节点、调设置才需要开面板

### 开机自启：只启面板，不启内核

登录时自动拉起面板服务和托盘，**内核要你自己点启动**。这是刻意的：
开机瞬间网络未必就绪，且如果有别的全局代理在跑，TUN 启动会被前置检查拦下 ——
自动启动只会让人一头雾水。

### 优雅停止（实测）

注销 / 关机走的就是 `systemctl --user stop`。服务用 `KillMode=mixed` + `TimeoutStopSec=30`，
只给主进程发 SIGTERM，让 `server.js` 的退出钩子依次停内核、拆 TUN、还原系统代理。
**硬杀会残留策略路由导致下次开机断网**，所以这条路径专门验证过：

```
systemctl --user stop  → 0.23s
  TUN 网卡          已消失 ✓
  9100 段策略路由   0 条残留 ✓
  路由表 2023       已空 ✓
  内核进程          0 个 ✓
  系统代理          已还原 mode=none ✓
```

### 常用命令

```bash
systemctl --user status singbox-router      # 服务状态
systemctl --user restart singbox-router     # 重启（会先优雅停内核）
journalctl --user -u singbox-router -f      # 实时日志
python3 app/gui.py                          # 手动起托盘
python3 app/window.py                       # 只开面板窗口
bash scripts/uninstall-app.sh               # 卸载集成（保留节点与设置）
```

卸载脚本按项目约定不用 `rm`，移除的文件统一移到 `~/.trash`。

---

## 默认端口

| 用途 | 端口 |
| --- | --- |
| Web 面板 | 8899 |
| 主代理端口 | 7890 |
| Clash API | 19090 |
| 节点独立端口 | 20800 起递增 |

都可以在设置里改。启动前会检查系统占用并明确报出是哪个端口被谁占了。

> 这台机器上已有 xray 占用 10808 / 10814、gopeed 占用 16800，默认值已避开。

---

## HTTP API

面板用的就是这套接口，只监听 `127.0.0.1`，并校验 `Host` / `Origin`（这个 API 能改系统代理、能起停进程，必须防 DNS rebinding 和跨站调用）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 设置 / 订阅 / 节点 / 内核状态一次取回 |
| POST | `/api/import` | `{text}` 多格式导入 |
| POST | `/api/subs` | `{url, name?, ua?}` 添加订阅并拉取 |
| POST | `/api/subs/:id/update` | 更新订阅 |
| DELETE | `/api/subs/:id?keepNodes=1` | 删除订阅（可保留节点） |
| PATCH | `/api/nodes/:id` | `{port?, enabled?, name?}` |
| POST | `/api/nodes/direct` | `{name?}` 新增虚拟【直连】节点 |
| DELETE | `/api/nodes/:id` | 删除节点 |
| POST | `/api/nodes/reassign-ports` | 从起始值重排全部端口 |
| POST | `/api/nodes/:id/test` · `/api/nodes/test-all` | 延迟测试（经 Clash API，需内核在跑） |
| POST | `/api/rules` | `{domain, ip, process, target, note?}` 新增分流规则 |
| PATCH | `/api/rules/:id` | 改规则（`{enabled}` 只切开关；其余字段重新校验） |
| DELETE | `/api/rules/:id` | 删除规则 |
| POST | `/api/rules/reorder` | `{ids}` 调整优先级（顺序即优先级） |
| PATCH | `/api/settings` | 改设置 |
| POST | `/api/core/start` · `stop` · `restart` · `apply` | 内核控制 |
| GET | `/api/config` | 预览生成的 sing-box 配置 |
| POST | `/api/sysproxy` | `{on: bool}` |
| POST | `/api/proxy/select` | `{name}` 切换主端口所用节点 |
| POST | `/api/mode` | `{mode: rule\|global\|direct}` |
| GET | `/api/logs/stream` | SSE：内核日志 + 状态推送 |
| GET | `/api/doctor` | 15 项体检一次跑完（含可脱敏粘贴的文本报告） |
| POST | `/api/doctor/fix` | `{action}` 一键修（白名单 8 个动作，见下） |
| POST | `/api/core/download` | `{mirror?, version?}` 面板内下载/更新内核 |
| POST | `/api/tun/authorize` · `/api/tun/recover` | pkexec 授权 TUN / 清理 TUN 残留 |
| POST | `/api/network/restart` | 重启网络服务（断网急救） |
| GET | `/api/rulesets` · POST `/api/rulesets/update` | 国内分流规则集状态 / 下载更新 |
| GET | `/api/termproxy` · POST `/api/termproxy` | 终端代理接管状态 / `{on: bool}` |
| POST | `/api/open/config-dir` | 用文件管理器打开数据目录 |

---

## 排查（doctor）

面板第 5 个标签页，15 项检查一次跑完：Node / 内核版本 / 数据目录 / 端口占用 / 配置自检 /
规则集 / TUN 权限 / **TUN 残留**（原 tun-recover 检测）/ 代理冲突 / pkexec 提权链 / 系统代理 /
终端代理 / 图形会话 / 桌面集成 / 内核运行态。能修的直接给按钮（与 `scripts/sbr-helper.sh` 走同一批函数）：

`download-core` · `download-rulesets` · `authorize-tun` · `recover-tun` · `restart-network` ·
`install-desktop` · `takeover-terminal` · `apply`

「复制报告」产出的文本**不含节点、订阅链接、密码、Clash secret**，可以直接贴到 issue 里求助。

---

## 数据目录

所有运行期数据在 **`~/.singbox-router/`**（state.json / config.json / cache.db / 规则集 / 系统代理备份）。
程序目录（git 仓库）里不再有任何运行期数据，仓库天然脱敏。

- 选 `~/.singbox-router` 而不是 `~/.cache`：里面有订阅 token 和节点凭据，清理工具不该碰
- 旧版本的数据在 `<项目>/data/`，面板启动时**一次性复制迁移**（不删原目录，新目录已有数据时绝不覆盖）
- 显式设置 `SBR_DATA_DIR` 时跳过迁移 —— 自检靠它拿隔离目录
- `browser-profile/`（76MB 旧版 Chrome 面板遗留）不迁移，确认无用后可自行清理

---

## 自检

不需要内核，纯验证解析与配置生成（34 项断言，含「直绑规则必须排在 CN 规则之前」这条分流核心不变量）：

```bash
npm test
# 等价于 SBR_DATA_DIR=/tmp/sbr-selftest node scripts/selftest.mjs
```

覆盖：YAML 解析器边界（嵌套、行内注释、`-   key` 多空格缩进、流式映射）、Clash→sing-box 字段映射、
各协议 URI 解析、importText 端到端、配置生成的端口分配与规则顺序。

### 已在本机实测通过

于 Linux Mint 22.3 / Cinnamon / Node 22.22 / **sing-box 1.13.18** 上验证：

- `npm test` 48/48 通过（proxy-utils 通路与自带解析器通路各跑一遍）
- `sing-box check` 校验生成的配置通过（纯代理 / TUN / 含直连节点 三种组合）
- **每节点端口分流生效**：5 个端口测出 5 个不同出口 IP
  （香港 `34.92.102.24` / 东京 `34.104.168.240` / 新加坡 `34.177.93.88` / 美国 `34.94.72.116` / DMIT `154.17.236.169`）
- **虚拟【直连】节点生效**：其端口出口为本机真实 ISP 地址（`123.173.27.71` 中国电信），
  而同时刻代理端口仍为机房 IP；`baidu.com` 经该端口 HTTP 200 / 0.19s
- **★ 端口绑定压过模式开关**（三种 clash 模式逐一实测）：

  | 模式 | 直连节点端口 | 代理节点端口 |
  | --- | --- | --- |
  | `global` 全局代理 | 仍为 ISP 出口 | 仍走各自节点 |
  | `direct` 全局直连 | 仍为 ISP 出口 | 仍走各自节点 |
  | `rule` | 仍为 ISP 出口 | 仍走各自节点 |

- **TUN 全局代理实测通过**（Linux Mint / Cinnamon，7 个真实节点）：
  - 网卡 `sbr-tun` 172.19.0.1/30，策略路由落在 **9100-9110 / 表 2023**，与 sing-box 默认值完全错开
  - 内核以**普通用户**运行（`setcap` 授权，非 root）
  - 不给任何程序配代理，全局流量与 DNS 均正常（`github.com` HTTP 200 / 1.7s）
  - TUN 与每节点端口、直连节点同时生效，互不干扰
- **polkit 免密生效**：`pkcheck` 确认那四个 `resolve1` 动作已授权，
  而对照动作 `org.freedesktop.systemd1.manage-units` 仍需授权 —— 规则范围精准，没有过度放权
- Clash API：延迟测试、模式读写、选择器切换均正常
- 系统代理接管 → 还原后 11 个 gsettings 键与接管前逐字节一致
- 崩溃恢复：残留接管态下重启面板，自动检测备份并还原为 `mode=none`
- 端口冲突校验、跨站/伪造 Host 请求拦截（403）、目录穿越拦截
- TUN 三道前置检查（**在 v2rayN 的 TUN 实际运行的环境下验证**）：
  权限正确识别；准确识别出 v2rayN 及其机制并拒绝启动；
  残留检测**不把 v2rayN 的活动规则误判成我们的残留**

> 排查提示：直连路径下 `1.1.1.1` 与 Cloudflare 系 IP（含 `api.ipify.org`）会超时或被 RST，
> 那是链路干扰不是本程序的问题。验证直连是否生效请用国内目标，例如 `myip.ipip.net`、`cip.cc`。

## 设计取舍：不做自动分流

早期版本用远程 geo 规则集（`.srs`）做国内直连和广告拦截，实测**规则集从未被成功下载**
（启动 0.03s、无任何 rule-set 日志、`cache.db` 不增长），那两个开关实际不起作用。

既然需求是「按端口精确分流」而不是「自动猜」，整套 geo 机制已删除。好处：

- 配置里零 `.srs` 引用，**没有任何启动期下载依赖**，离线也能起
- 要让某些流量直连，加一个 **虚拟【直连】节点** 把程序指过去 —— 比域名规则精确且可预期

---

## 目录结构

```
server.js              HTTP API + 静态服务 + 安全校验
src/store.js           状态持久化、端口分配、tag 唯一化、数据目录迁移
src/parse.js           多格式 → sing-box outbound（含 proxy-utils 通路）
src/yaml.js            精简 YAML 解析器（Clash 配置用）
src/config.js          ★ 生成 sing-box 配置，分流规则在这里
src/core.js            内核进程管理 + Clash API 客户端
src/sysproxy.js        gsettings 系统代理接管与还原
src/subscribe.js       订阅拉取与增量同步
src/ruleset.js         国内分流规则集（geoip-cn / geosite-cn .srs 下载与引用）
src/termproxy.js       终端代理接管（rc 文件挂 source 片段，带活性检查）
src/doctor.js          15 项体检 + 一键修 + 可脱敏文本报告
src/setup.js           内核下载 / TUN 授权 / 断网急救（pkexec → scripts/sbr-helper.sh）
src/open.js            打开配置文件夹（xdg-open 系列回退）
public/                单页面板（原生 JS，无框架）
app/gui.py             托盘常驻（GTK + AppIndicator，只调面板 API，不含 WebKit）
app/window.py          面板窗口（WebKitGTK，独立进程，关窗即退出）
scripts/sbr-helper.sh  root 侧助手（参数白名单校验，被 pkexec 调用）
scripts/cli.mjs        命令行版（调面板同款函数）
scripts/get-core.sh    下载 sing-box 内核
scripts/setup-tun.sh   一次性授权(setcap + polkit)
scripts/tun-recover.sh 断网急救
scripts/install-app.sh 装成桌面应用(服务+托盘+菜单入口)
~/.singbox-router/     运行期数据（配置、状态、缓存、规则集、代理备份）
```

---

## 已知限制

- **TUN 需要一次性 sudo**（`setup-tun.sh` 加 capability，或在排查页点「一次性授权 TUN」）。之后启动停止都不再需要密码。纯代理模式完全不需要 root。
- **默认不做自动分流**：见「设计取舍」一节。想要「国内直连、国外代理」可在设置里开「国内自动分流」（排在所有显式规则之后）。需要精确控制请用自定义规则或虚拟【直连】节点。
- **不支持 ShadowsocksR**（sing-box 本身已移除），WireGuard 节点在 sing-box 1.11+ 属于 endpoint，暂不支持从链接导入。
- 系统代理接管**只实现了 gsettings 路径**。KDE / 纯 WM 环境请用生成的 `proxy-env.sh`，或直接用 TUN。
- 面板无鉴权，仅监听回环。**不要用端口转发把 8899 暴露出去。**
