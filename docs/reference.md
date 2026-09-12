# 参考

- [支持导入的格式](#支持导入的格式)
- [订阅](#订阅)
- [系统代理接管](#系统代理接管)
- [数据目录](#数据目录)
- [设置项](#设置项)
- [HTTP API](#http-api)
- [自检](#自检)
- [目录结构](#目录结构)

---

## 支持导入的格式

面板「导入」页粘贴即可,自动识别:

- **订阅 base64** —— 整段 base64 的分享链接列表
- **分享链接**,可多行混合:`vless://` `vmess://` `ss://` `trojan://` `hysteria2://` `hy2://` `hysteria://` `tuic://` `anytls://` `socks://` `http://`
- **Clash / mihomo YAML** —— 含 `proxies:` 的配置,内置精简 YAML 解析器
- **sing-box JSON** —— 出站数组,或含 `outbounds` 的完整配置
- **单个 JS 对象字面量**,形如 `const newProxy = { name: "...", type: "vless", ... }`

解析走**两条独立通路,互为兜底**:

1. **proxy-utils**([Sub-Store](https://github.com/sub-store-org/Sub-Store) 的解析库)—— 覆盖面最广,存在就优先用。自动探测:
   - `./vendor/proxy-utils.esm.mjs`
   - `~/data/third/node-convert/proxy-utils.esm.mjs`(装过 GUI.for.SingBox 的「节点转换」插件就有)
2. **内置解析器** —— 上面那些格式都自己实现了一遍,proxy-utils 缺失或报错时接管

面板顶栏会显示 proxy-utils 是否已加载。

> proxy-utils 是为 Sub-Store 运行时写的,直接在裸 Node ESM 里 import 会踩几个坑:它用 CJS `require`、会尝试 `require('dotenv')` 这类不一定存在的模块、会往 cwd 写 `root.json`、还会 monkey-patch `console.log` 加时间戳前缀。本项目给它套了 shim:`createRequire` + 对无法解析的模块返回 Proxy 桩 + fs 桩(让它走无缓存路径,不落任何文件)+ import 前后快照并还原 console。

## 订阅

按 UA 拉取,默认 `clash.meta/1.19.0`(拿 Clash YAML 兼容性最好)。机场常按 UA 返回不同格式,拿不到节点时可以换 `sing-box` 或 `v2rayN` 重试。

订阅更新是**增量**的:

- 消失的节点会被移除
- 仍在的节点**保留你分配的端口和启用开关**(按订阅内的节点名匹配)
- 面板显示节点数、格式、更新时间,以及机场返回的流量与到期信息(如果有)

## 系统代理接管

Linux 桌面走 `gsettings`(Cinnamon / GNOME / MATE / Xfce 等)。点「接管系统代理」或在设置里开自动接管,会把 http / https / socks 三项都指向主端口。

三条安全约定:

1. **改之前把原值原样备份到磁盘**(`~/.config/singbox-router/sysproxy-backup.json`),不是只存内存
2. **内核意外退出会自动还原**,不会让机器留在「代理指向一个已死端口」的断网状态
3. **面板进程启动时检查残留备份**并自动还原 —— 上次异常退出也能救回来

`gsettings` 管不到命令行程序,所以接管时会生成一份 export 片段:

```bash
source ~/.config/singbox-router/proxy-env.sh
```

## 数据目录

所有运行期数据都在 **`~/.config/singbox-router`**(遵循 XDG,`XDG_CONFIG_HOME` 生效时以它为基):

```
state.json              设置 / 订阅 / 节点 / 自定义规则(原子写入:写临时文件再 rename)
config.json             生成给内核的 sing-box 配置
sysproxy-backup.json    系统代理原值备份
proxy-env.sh            命令行用的 export 片段
cache.db                内核自己的缓存
rulesets/*.srs          GeoIP / GeoSite 规则集
```

**程序目录里不再有任何运行期数据。**订阅 token、节点凭据、规则集都在家目录下,所以仓库天然是脱敏的 —— 克隆一份代码不会带出任何私密信息,`git status` 也不会因为跑过程序而变脏。

老版本把这些写在程序目录的 `data/` 下。首次启动会**复制**(不是移动)到新目录,并在旧目录留一份 `MIGRATED.txt` 说明:

- 新目录已有 `state.json` 时**一律不覆盖**
- 旧目录**不删** —— 迁移过程中断也不会丢东西,确认新目录正常后自行清理
- 面板顶部会提示这次迁移搬了哪些文件

打开这个目录有两条路,都不需要记路径:

- 面板「设置 → 数据目录 → 打开配置文件夹」
- 托盘菜单「打开配置文件夹」

> 面板那个按钮走的是后端(`POST /api/open/config-dir`)。后端由 systemd `--user` 托管,不保证有 `DISPLAY`/`DBUS_SESSION_BUS_ADDRESS`,那种情况下 `xdg-open` 会**静默失效** —— 所以后端会先检查环境变量,再依次试 `xdg-open` / `gio open` / `nemo` / `nautilus` / `thunar` / `dolphin` / `caja` / `pcmanfm`,全都不行就把路径回传给面板复制到剪贴板。托盘那条路不受影响:托盘自己就是 GTK 程序,一定坐在图形会话里。

`SBR_DATA_DIR` 环境变量可覆盖数据目录。指定它时**不做迁移** —— 自检靠这个拿到一个干净、隔离的目录。

## 设置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `webPort` | `8899` | Web 面板端口 |
| `mainPort` | `7890` | 主代理端口 |
| `portBase` | `20800` | 节点独立端口起始值 |
| `clashApiPort` | `19090` | Clash API 端口 |
| `allowLan` | `false` | 监听 `0.0.0.0` 而非 `127.0.0.1` |
| `dnsLocal` | `223.5.5.5` | 国内 DNS,UDP 直连 |
| `dnsRemote` | `8.8.8.8` | 国外 DNS,DoT/853 经代理 |
| `autoSetSystemProxy` | `true` | 内核启动时自动接管系统代理,停止时还原 |
| `autoAssignPorts` | `true` | 导入节点时自动分配独立端口 |
| `autoStartCore` | `false` | 面板服务启动后静默自启内核 |
| `chinaDirect` | `false` | 国内自动分流(GeoIP + GeoSite 命中即直连) |
| `rulesetSource` | `auto` | `auto` 本地有就用本地、缺就远程 / `local` 只用本地(缺文件在启动前报错)/ `remote` 始终远程 |
| `rulesetMirror` | `''` | 规则集下载镜像前缀,如 `https://ghfast.top/`,用法同 `SB_MIRROR` |
| `rulesetUpdateInterval` | `7d` | 仅远程模式:内核自己的更新周期 |
| `tunEnabled` | `false` | 启用 TUN 全局代理 |
| `tunInterface` | `sbr-tun` | TUN 网卡名 |
| `tunAddress` | `172.19.0.1/30` | TUN 网卡地址 |
| `tunMTU` | `9000` | |
| `tunStack` | `mixed` | `system` / `gvisor` / `mixed` |
| `tunStrictRoute` | `true` | 严格路由,防止流量绕过 |
| `tunTableIndex` | `2023` | 刻意避开 sing-box 默认 2022,见 [tun.md](tun.md#刻意错开路由表索引) |
| `tunRuleIndex` | `9100` | 刻意避开默认 9000 |
| `testUrl` | `gstatic.com/generate_204` | 延迟测试与 `auto` 组测速地址 |
| `testTimeout` | `5000` | ms |
| `logLevel` | `info` | |
| `corePath` | `''` | 留空则自动探测 sing-box |
| `bypassList` | 见 `src/store.js` | 系统代理绕过列表 |

状态存在 `~/.config/singbox-router/state.json`,原子写入(写临时文件再 rename)。自定义分流规则也在同一个文件里(`rules` 数组,顺序即优先级)。详见 [数据目录](#数据目录)。

## HTTP API

面板用的就是这套接口。只监听 `127.0.0.1`,并校验 `Host` / `Origin` —— 这个 API 能改系统代理、能起停进程,必须防 DNS rebinding 和跨站调用。不合规直接 403。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 设置 / 订阅 / 节点 / 规则 / 内核状态一次取回,含 `dataDir` 与迁移结果 |
| POST | `/api/import` | `{text}` 多格式导入 |
| POST | `/api/subs` | `{url, name?, ua?}` 添加订阅并拉取 |
| POST | `/api/subs/:id/update` | 更新订阅 |
| DELETE | `/api/subs/:id?keepNodes=1` | 删除订阅(可保留节点) |
| PATCH | `/api/nodes/:id` | `{port?, enabled?, name?}` |
| POST | `/api/nodes/direct` | `{name?}` 新增虚拟【直连】节点 |
| DELETE | `/api/nodes/:id` | 删除节点 |
| POST | `/api/nodes/reassign-ports` | 从起始值重排全部端口 |
| POST | `/api/nodes/:id/test` · `/api/nodes/test-all` | 延迟测试(经 Clash API,需内核在跑) |
| GET | `/api/rules/meta` | 规则类型 / 匹配方式 / 去向的可选值(前端下拉框用) |
| POST | `/api/rules` | `{kind, match, values, target, note?}` 新增分流规则,校验不过返回 400 |
| PATCH | `/api/rules/:id` | 改规则;只带 `enabled` 时不重新校验内容 |
| DELETE | `/api/rules/:id` | 删除规则 |
| POST | `/api/rules/reorder` | `{ids}` 按给定顺序重排 —— **顺序即优先级** |
| GET | `/api/rulesets` | 规则集本地状态(在不在、多大、何时下的)与实际生效来源 |
| POST | `/api/rulesets/update` | `{mirror?}` 下载 / 更新 `.srs`,失败返回 502 并说明原因 |
| POST | `/api/open/config-dir` | 用文件管理器打开数据目录;打不开时返回路径供面板复制 |
| PATCH | `/api/settings` | 改设置 |
| POST | `/api/core/start` · `stop` · `restart` · `apply` | 内核控制 |
| GET | `/api/config` | 预览生成的 sing-box 配置 |
| POST | `/api/sysproxy` | `{on: bool}` |
| POST | `/api/proxy/select` | `{name}` 切换主端口所用节点 |
| POST | `/api/mode` | `{mode: rule\|global\|direct}` |
| GET | `/api/logs/stream` | SSE:内核日志 + 状态推送 |

前端所有 DOM 都用 `document.createElement` 构建,**从不拼 `innerHTML`** —— 节点名来自订阅,是不可信输入。

## 自检

不需要内核,纯验证解析与配置生成:

```bash
npm test
# 等价于 SBR_DATA_DIR=/tmp/sbr-selftest node scripts/selftest.mjs
```

**77 项断言**,覆盖:

- YAML 解析器边界:嵌套块映射、行内注释剥离(引号内 `#` 保留)、`-   key` 多空格缩进、流式映射、点分 IP 不被当成小数
- Clash → sing-box 字段映射
- 各协议 URI 解析(含 reality / ws early-data / grpc / vmess base64 JSON / ss SIP002 与旧版整段 base64)
- `importText` 端到端(base64 订阅、混合多行链接、JS 对象字面量)
- 配置生成:端口分配、tag 唯一化、**规则顺序不变量**、TUN 入站、DNS 走向
- 数据目录:`SBR_DATA_DIR` 优先、XDG 默认值(**子进程**里验证,不碰真实目录)、运行期文件全部落在数据目录内
- 自定义规则:输入规范化(协议前缀 / 路径 / `*.` / 大小写)、裸 IP 补掩码、**IP 正则被拒绝并给出 CIDR 建议**、**RE2 不支持的构造在保存时就拦下**(而 `(?P<name>…)` 必须放行)、悬空节点引用不产出规则
- 国内自动分流:`local` 只引用本地绝对路径、**geo 规则排在所有显式规则之后**、DNS 侧配套规则、`remote` 带 `download_detour` 与更新周期、镜像拼接、`auto` 的退回逻辑、缺文件时 `validate()` 说清缺哪份

带 ★ 的断言守的是核心不变量,改动路由生成逻辑时最该看它们。测试夹具里的 UUID、IP、公钥都是合成值(IP 用 RFC 5737 文档保留段)。geo 相关的断言用**伪造的 `.srs` 文件**(只有魔数)驱动,全程不联网。

## 目录结构

```
server.js              HTTP API + 静态服务 + 安全校验 + 静默自启
src/store.js           状态持久化、端口分配、tag 唯一化、数据目录解析与迁移
src/parse.js           多格式 → sing-box outbound（含 proxy-utils 通路）
src/yaml.js            精简 YAML 解析器（Clash 配置用）
src/config.js          ★ 生成 sing-box 配置，规则顺序在这里
src/rules.js           自定义分流规则：校验 / 正则体检 / 翻译成 route 规则
src/ruleset.js         GeoIP / GeoSite 规则集：下载、状态、local-vs-remote
src/open.js            用文件管理器打开目录（环境检查 + 多 opener 兜底）
src/core.js            内核进程管理 + Clash API 客户端 + TUN 前置检查
src/sysproxy.js        gsettings 系统代理接管与还原
src/subscribe.js       订阅拉取与增量同步
public/                单页面板（原生 JS，无框架，无构建步骤）
app/gui.py             托盘常驻（GTK3 + AppIndicator，只调面板 API，不含 WebKit）
app/window.py          面板窗口（WebKitGTK，独立进程，关窗即退出）
scripts/get-core.sh    下载 sing-box 内核
scripts/get-geoip.sh   下载 GeoIP / GeoSite 规则集到数据目录
scripts/setup-tun.sh   一次性授权（setcap + polkit）
scripts/tun-recover.sh 断网急救
scripts/install-app.sh 装成桌面应用（服务 + 托盘 + 菜单入口）
scripts/uninstall-app.sh
scripts/build-deb.sh   打 .deb 包
scripts/selftest.mjs   77 项断言

~/.config/singbox-router/   运行期数据（状态、凭据、规则集、内核缓存），见上文「数据目录」
```

程序目录里**不产生**运行期数据 —— 仓库里没有任何需要 gitignore 的敏感文件。`data/` 仍在 `.gitignore` 里,只是为了兜住老版本升级前留下的那一份。
