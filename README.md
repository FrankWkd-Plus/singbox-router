# singbox-router

> **每个节点一个独立端口。把程序指向端口，它的流量就永远从那个节点出去。**

基于 [sing-box](https://github.com/SagerNet/sing-box) 的 Linux 桌面分流客户端。零 npm 依赖（纯 Node stdlib）、零启动期下载、原生 JS 单页面板，可选装成系统托盘常驻的桌面应用（WebKitGTK，**不是 Electron**）。

`节点` `订阅` `规则` `TUN` `排查` —— 五个页面就是全部，没有订阅转换、没有配置模板、没有 YAML。

---

## 你大概也遇到过这些

**1. 「切个节点，全都跟着切了。」**
你只是想让浏览器换到美国节点，结果 Telegram、git、npm 的出口一起换了 —— 因为传统客户端只有一个代理端口，切节点 = 切全局。想多节点**同时**用？去改 Clash 配置文件，手写好几个 listener 和 proxy-group —— 然后机场订阅一更新，全被冲掉。

**2. 「为什么这个网站走了代理？」**
几千条 geosite 规则的黑盒里，你不知道哪条命中了、为什么命中。规则错了没有任何提示，流量静悄悄地走了错误的出口。

**3. 「TUN 一开，别的客户端炸了。」**
v2rayN 等客户端的 TUN 都用 sing-box 的默认路由表索引（表 2022 / 规则段 9000）。两个 sing-box 客户端同时开，互相覆盖对方的策略路由 —— 对面核心被打断、反复弹 sudo 框、DNS 崩掉。

**4. 「内核被杀了一次，整机断网。」**
TUN 模式下内核被 `kill -9` 或机器硬崩，策略路由残留指向一块已消失的网卡。多数客户端只留给你一个选择：重启电脑。

**5. 「curl / git / npm 根本不认系统代理。」**
每次都要手动 `export https_proxy=...`，换台机器、开个新终端又得来一遍。

**6. 「面板常驻 900MB。」**
Electron / Chromium 壳的代理客户端，托盘挂一天就是一天的内存。

这六件事，本项目分别用：端口直绑、显式规则、错开路由索引、断网急救、终端代理接管、182MB 常驻来解决。往下逐条看。

---

## 为什么不是 Clash / v2rayN

先说清楚：Clash 生态成熟、跨平台、订阅兼容性无出其右；v2rayN 功能全、内核切换灵活。**如果你要的是「一个端口、规则自动分流、多平台通用」，它们是正确选择。**

本项目回答的是另一个问题：**Linux 桌面上，我要不同程序同时走不同出口，并且每一条流量我都说得清它是怎么走的。**

| 需求 | Clash 系（Verge / mihomo） | v2rayN / v2rayA | singbox-router |
| --- | --- | --- | --- |
| 多节点同时用（TG 走香港、git 走日本、浏览器走美国） | 手写多 listener + proxy-group，订阅更新会冲掉（要用 merge/覆写保住） | 基本做不到 | ✅ **每个节点自动一个端口**，`git config http.proxy :20801` 完事 |
| 个别程序强制直连（银行、公司内网） | 写规则，猜域名 | 写规则 | ✅ 虚拟【直连】节点：程序指向端口，**任何模式下都直连** |
| 规则可预期 | 几千条 geosite 黑盒，错了无提示 | 同左 | ✅ 规则只有你写的那几条，**列表顺序 = 匹配优先级** |
| 规则正则（域名 / 进程路径） | mihomo 支持 | 视内核而定 | ✅ 保存时就按 Go RE2 校验，写错当场拦下 |
| 与其他 sing-box 客户端同机共存 | TUN 默认索引互相覆盖 | ❌ TUN 默认索引互相覆盖 | ✅ **刻意错开**（表 2023 / 段 9100），清理工具只动自己的资源 |
| TUN 断网自救 | 自己翻文档清路由 | 自己翻文档清路由 | ✅ doctor 一键清理，托盘在面板打不开时也能救 |
| 出问题怎么排查 | 看日志、问群 | 看日志、问群 | ✅ **15 项体检**：权限 / 冲突 / 残留 / 端口 / 配置，能修的直接给按钮 |
| 命令行代理 | 手动 export | 手动 export | ✅ 一键接管：往 shell rc 挂 source 片段，新终端自动走代理 |
| 常驻内存 | Electron 壳数百 MB 起 | 视实现 | ✅ **182MB**（实测，含内核） |
| 跨平台 | ✅ | ✅（Windows 优先） | ❌ **Linux 桌面专用**（gsettings / GTK / systemd） |
| 订阅生态 / 配置模板 / 覆写 | ✅ 最强 | ✅ | ❌ 刻意不做 —— 订阅只管拿节点，端口和开关永远保留 |

一句话总结取舍：**Clash 把「自动猜」做到了极致，本项目把「显式指定」做到了极致。** 规则引擎我们也有（域名 / IP / 进程、正则、顺序即优先级、可选国内自动分流），但它永远排在端口直绑之下 —— 你显式指定的东西，不会被一层猜测静默推翻。

### 实测背书

不是纸面设计。以下全部在本机（Linux Mint 22.3 / Cinnamon / sing-box 1.13.18）验证过：

- **5 个端口测出 5 个不同出口 IP**（香港 / 东京 / 新加坡 / 美国 / DMIT）
- 端口绑定**压过模式开关**：全局代理、全局直连、规则三种模式下逐一实测，独立端口出口纹丝不动
- TUN 与每节点端口同时生效，互不干扰；TUN 前置检查在 **v2rayN 的 TUN 实际运行的环境下**验证 —— 准确识别、拒绝启动、且不误判它的活动规则
- `systemctl --user stop` 优雅停止 0.23s：网卡消失、策略路由零残留、系统代理还原 —— 断网事故的根源路径专门验证过

---

## 核心机制：端口即出口

生成的 sing-box 配置里有两类入站：

| 入站 | 端口 | 行为 |
| --- | --- | --- |
| `in-main` | `7890`（可改） | 走 `proxy` 选择器（所选节点 / auto / direct） |
| `in-tun` | 网卡 `sbr-tun` | 同上，但透明捕获全部程序 |
| `in-<节点id>` | 每节点一个，默认从 `20800` 起 | **直绑该节点**，流量固定从这个节点出去 |
| `in-<直连节点id>` | 虚拟【直连】节点 | **直绑内置 `direct`**，任何模式下都不经代理 |

用法直接得不需要解释：

```bash
# 假设面板给「日本 02」分了 20803
curl -x http://127.0.0.1:20803 https://ip.sb          # 从日本出

# 不同工具绑不同节点，互不干扰
git  config --global http.proxy http://127.0.0.1:20801   # git 走香港
npm  config set proxy            http://127.0.0.1:20802  # npm 走新加坡
export https_proxy=http://127.0.0.1:20803                # 当前 shell 走日本
```

每个端口都是 `mixed` 入站，**HTTP 和 SOCKS5 共用同一端口**，`socks5://127.0.0.1:20803` 同样可用。

路由整体优先级：**端口直绑 → 模式开关 → 自定义规则 → 私有地址 → 国内自动分流（可选）→ 默认走代理**。直绑规则刻意排在 `clash_mode` 之前 —— 独立端口是你显式指定的，模式开关只该影响全局流量，否则「切到全局直连」会把你的端口绑定静默推翻，而界面上看不出任何异常（这条真的踩过坑）。

规则顺序是配置生成的不变量，自检里有多条 ★ 断言守着。完整机制（七层规则表、为什么这么排、虚拟直连节点的语义）见 **[docs/splitting.md](docs/splitting.md)**。

### 自定义分流规则（可选层）

面板「规则」页，一条规则 = **域名 / IP / 进程的任意组合 → 同一个去向**（直连 / 走代理 / 拦截 / 某个节点）。规则**从上到下**依次匹配，上面的优先：

| 栏 | 写法 | 说明 |
| --- | --- | --- |
| 域名 | `github.com` | 后缀匹配，含所有子域名；粘贴整条 URL 会自动剥掉协议和路径 |
| 域名 | `re:^.*\.cn$` | `re:` 前缀 = 正则（Go RE2） |
| IP | `198.51.100.7` · `10.0.0.0/8` | 裸 IP 自动补 /32 或 /128；**IP 没有正则**（sing-box 走前缀树） |
| 进程 | `telegram-desktop` | 按进程名匹配 |
| 进程 | `/usr/bin/curl` | 以 `/` 开头 = 按完整路径匹配 |
| 进程 | `re:^/usr/lib/firefox/` | 路径正则（裸 `^` 开头自动识别） |

正则按 Go RE2 语法在**保存时**校验（不支持前后向断言、反向引用；命名分组写 `(?P<name>…)`），而不是等内核启动报错。进程匹配对 TUN 和本地代理端口都有效 —— 但走独立节点端口的流量被端口直绑优先截走，不经过自定义规则。

想要「国内直连、国外代理」而不想写规则？设置里开「国内自动分流」，geosite-cn / geoip-cn 命中即直连，排在所有显式规则之后。规则集先下到本地再引用（面板一键下载，显示大小和时间），关掉后配置里零 `.srs` 引用、离线也能起。

---

## 安装

需要 **Node >= 20** 和 **sing-box >= 1.12**（配置用 1.12 的 schema，旧内核会因未知字段启动失败。实测 1.13.18）。

```bash
git clone https://github.com/FrankWkd-Plus/singbox-router.git
cd singbox-router

bash scripts/get-core.sh     # 下载内核到 ./bin/sing-box
node server.js               # 启动面板
```

打开 <http://127.0.0.1:8899> → 订阅或导入节点 → 点「启动」。

下载被墙时：`SB_MIRROR=https://ghfast.top/ bash scripts/get-core.sh`，或 `https_proxy=...`，或在设置里直接填一个已有的 sing-box 路径。内核也可以在面板「排查」页一键下载。

### 装成桌面应用

```bash
bash scripts/install-app.sh                    # 源码目录装法，不需要 root
# 或 Debian/Ubuntu/Mint：
bash scripts/build-deb.sh && sudo apt install ./dist/singbox-router_*.deb
```

开始菜单入口 + 托盘常驻 + 登录自启。**不用 Chromium 也不用 Electron**：面板窗口走 WebKitGTK，渲染同一套 web UI，常驻内存 **182MB**（Chrome 方案 910MB，实测数字和进程拆分见 [docs/desktop.md](docs/desktop.md)）。内核由 systemd 用户服务托管 —— **关面板、退托盘都不断网**。

### 支持导入的格式

面板「导入」页粘贴即可，自动识别：**订阅 base64**、**分享链接**（`vless/vmess/ss/trojan/hysteria2/hysteria/tuic/anytls/socks` 可多行混合）、**Clash / mihomo YAML**、**sing-box JSON**、**单个 JS 对象字面量**。解析走两条独立通路互为兜底：[Sub-Store 的 proxy-utils](https://github.com/sub-store-org/Sub-Store)（存在就优先用，覆盖面最广）+ 内置解析器。

订阅按 UA 拉取（默认 `clash.meta/1.19.0`，可换），更新是**增量**的：消失的节点移除，仍在的**保留你分配的端口和开关** —— 订阅更新永远不会冲掉你的分流安排。

---

## 系统代理与 TUN

**系统代理**（gsettings，Cinnamon/GNOME/MATE/Xfce）：改之前原值备份到磁盘，内核意外退出自动还原，面板启动时检查残留备份自愈。`gsettings` 管不到的命令行程序，开「终端代理接管」一键挂 source 片段（新开的终端自动走代理，已开着的给你一行命令复制）。

**TUN 全局代理**：让所有程序（含不认系统代理的）自动走代理。一次性授权（`setcap` + polkit 免密）之后启停都不再需要密码，内核以普通用户运行。三道启动前置检查把会导致断网的情况拦在启动前：

1. **权限** —— 内核有没有 `CAP_NET_ADMIN`
2. **冲突** —— 自动识别 v2rayA / v2rayN / Clash 在跑并拒绝启动（它们和 TUN 会互相抢路由）
3. **残留** —— 上次异常退出留下的死策略路由

路由表索引**刻意错开**（本项目 `sbr-tun` / 表 2023 / 段 9100，sing-box 默认和 v2rayN 用 2022 / 9000）：内核层面不再互相覆盖，急救脚本**只清理自己的资源，绝不会拆掉别人正在工作的 TUN**。国外 DNS 走 DoT 而非 UDP —— UDP DNS 在很多节点上会超时，表现就是「网页能连但域名解析不了」。万一还是断网了：排查页或托盘「TUN 断网急救」一键恢复（面板打不开时托盘那条路还在）。

细节（polkit 四个动作为什么也要授权、DNS 双重劫持、优雅停止验证记录）见 **[docs/tun.md](docs/tun.md)**。

---

## 排查（doctor）：坏了能自己救

面板第 5 个标签页，15 项检查一次跑完：Node / 内核版本 / 数据目录 / 端口占用 / 配置自检 / 规则集 / TUN 权限 / **TUN 残留** / 代理冲突 / pkexec 提权链 / 系统代理 / 终端代理 / 图形会话 / 桌面集成 / 内核运行态。**能修的直接给按钮**：下载内核、下载规则集、授权 TUN、清理残留、重启网络、装桌面集成、接管终端、应用配置 —— 原来要开终端跑脚本的事全变成一次点击。

「复制报告」产出的文本**不含节点、订阅链接、密码、Clash secret**，可以直接贴到 issue 里求助。

---

## 默认端口

| 用途 | 端口 |
| --- | --- |
| Web 面板 | 8899 |
| 主代理端口 | 7890 |
| Clash API | 19090 |
| 节点独立端口 | 20800 起递增 |

都可以在设置里改，启动前会检查占用并明确报出被谁占了。

## 数据目录

所有运行期数据在 **`~/.singbox-router/`**（state.json / config.json / cache.db / 规则集 / 系统代理备份）。程序目录里没有任何运行期数据，**仓库天然脱敏** —— `git status` 永远干净。选 `~/.singbox-router` 而不是 `~/.cache`：里面有订阅 token 和节点凭据，清理工具不该碰。旧版本 `<项目>/data/` 的数据在面板启动时一次性复制迁移（不删原目录，绝不覆盖已有数据）。

## HTTP API

面板用的就是这套接口，只监听 `127.0.0.1` 并校验 `Host` / `Origin`（能改系统代理、能起停进程的 API 必须防 DNS rebinding 和跨站调用）。完整表格见 **[docs/reference.md](docs/reference.md#http-api)**，节选：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 设置 / 订阅 / 节点 / 内核状态一次取回 |
| POST | `/api/import` · `/api/subs` | 导入 / 订阅 |
| PATCH | `/api/nodes/:id` | `{port?, enabled?, name?}` |
| POST | `/api/rules` · `/api/rules/reorder` | 自定义规则（顺序即优先级） |
| POST | `/api/core/start` · `stop` · `restart` · `apply` | 内核控制 |
| GET | `/api/doctor` · POST `/api/doctor/fix` | 15 项体检 / 一键修 |
| POST | `/api/core/download` · `/api/rulesets/update` | 面板内下载内核 / 规则集 |
| POST | `/api/tun/authorize` · `/api/tun/recover` · `/api/network/restart` | 特权动作（pkexec） |
| GET/POST | `/api/termproxy` | 终端代理接管 |
| GET | `/api/logs/stream` | SSE：内核日志 + 状态推送 |

## 自检

不需要内核，纯验证解析与配置生成：

```bash
npm test    # 77 项断言，含「直绑规则必须排在 clash_mode 之前」等分流核心不变量
```

### 已在本机实测通过

于 Linux Mint 22.3 / Cinnamon / Node 22.22 / **sing-box 1.13.18**：

- `npm test` 77/77 通过（proxy-utils 通路与自带解析器通路各跑一遍）；`sing-box check` 三种配置组合（纯代理 / TUN / 含直连节点）通过
- **每节点端口分流生效**：5 端口 5 出口 IP；**虚拟【直连】节点**端口出口为本机真实 ISP 地址（同时刻代理端口仍为机房 IP）
- **端口绑定压过模式开关**（三种 clash 模式逐一实测，见上文表格）
- **TUN 实测**：普通用户运行（setcap）、不给任何程序配代理全局流量与 DNS 正常、与每节点端口共存；前置检查在 v2rayN TUN 实际运行环境下验证
- polkit 免密范围精准（对照动作仍需授权）；系统代理还原后 11 个 gsettings 键逐字节一致；崩溃恢复、端口冲突校验、跨站/伪造 Host 拦截（403）、目录穿越拦截

> 排查提示：直连路径下 `1.1.1.1` 与 Cloudflare 系 IP 会超时或被 RST，那是链路干扰不是本程序的问题。验证直连请用国内目标，如 `myip.ipip.net`、`cip.cc`。

## 已知限制

- **Linux 桌面专用**：系统代理走 gsettings（KDE / 纯 WM 用 `proxy-env.sh` 或 TUN），桌面集成基于 GTK / systemd。
- **TUN 需要一次性 sudo**（`setup-tun.sh`，或排查页一键授权），之后启停免密。纯代理模式完全不需要 root。
- **默认不做自动分流**（设计取舍：按端口精确分流 + 自定义规则为主，自动分流是可选层）。见上文。
- **IP 规则无正则**（sing-box 前缀树匹配，内核里没有跑正则的地方）；正则是 Go RE2，不支持前后向断言与反向引用 —— 两者都在保存时拦下并给出建议。
- 不支持 ShadowsocksR（sing-box 已移除）；WireGuard 在 1.11+ 属 endpoint，暂不支持链接导入。
- 面板无鉴权，仅监听回环。**不要用端口转发把 8899 暴露出去。**

## 文档

| | |
| --- | --- |
| [docs/splitting.md](docs/splitting.md) | 分流机制：七层规则顺序、虚拟直连节点、自定义规则、国内自动分流 |
| [docs/tun.md](docs/tun.md) | TUN：免密授权、三道前置检查、错开路由索引、DNS、断网急救 |
| [docs/desktop.md](docs/desktop.md) | 桌面应用：进程架构、内存实测、开机自启、优雅停止、.deb 打包 |
| [docs/reference.md](docs/reference.md) | 导入格式、订阅、设置项、HTTP API、自检、目录结构 |

英文概览：**[README.en.md](README.en.md)**

## License

[MIT](LICENSE)
