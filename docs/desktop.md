# 桌面应用

装完就是个正常的桌面应用:开始菜单有入口,托盘常驻,登录自启 —— 不是一个要 `cd` 进去 `node server.js` 的目录。

两种装法,选一个:

| | 命令 | 适合 |
| --- | --- | --- |
| **`.deb` 包** | `sudo apt install ./singbox-router_*.deb` | Debian / Ubuntu / Mint。系统级安装,程序在 `/usr/lib` 下只读 |
| **源码目录** | `bash scripts/install-app.sh` | 想改代码、或不用 dpkg 的发行版。全程不需要 root |

> **两种别同时用。**两边的 systemd 单元与 autostart 项**文件名相同**,而用户目录里的那份会盖住系统目录里的那份 —— 于是 `.deb` 装的那份变成哑的,服务实际指向的是源码目录;`~/.local/bin/singbox-router` 和 `/usr/bin/singbox-router` 谁生效则取决于 PATH 顺序。真正会咬人的是之后把源码目录挪走或删掉:服务还指着它,而系统里那份被盖着不会顶上来。`.deb` 里因此刻意不含 `install-app.sh`。

不管哪种装法,**运行期数据都在 `~/.singbox-router`**,换装法不会丢节点和设置。

**不用 Chromium 也不用 Electron。** 面板窗口走 WebKitGTK,渲染的是同一套 web UI,外观一行不改,但常驻内存从 910MB 降到 182MB。

## `.deb` 包

```bash
bash scripts/build-deb.sh            # 产物在 dist/
sudo apt install ./dist/singbox-router_1.0.0-1_all.deb
```

用 `apt install ./xxx.deb` 而不是 `dpkg -i`:前者会自动装依赖,后者只会报缺依赖。

架构写 `all` —— 整个程序是 Node + Python,没有一行编译产物。

装完落在这些位置:

| 路径 | 内容 |
| --- | --- |
| `/usr/lib/singbox-router/` | 程序本体,只读,**不产生任何运行期数据** |
| `/usr/bin/singbox-router` | 打开面板窗口 |
| `/usr/lib/systemd/user/singbox-router.service` | 面板后端,**用户级**服务 |
| `/usr/share/applications/…` | 开始菜单入口 |
| `/etc/xdg/autostart/…-tray.desktop` | 登录时起托盘(登记为 conffile,升级不覆盖你的改动) |
| `/usr/share/doc/singbox-router/` | README、`docs/`、`README.Debian` |
| `~/.singbox-router/` | 你的设置、节点、订阅凭据、规则集 |

内核**不在包里**(几十 MB、按架构分发、还要单独 `setcap`),装完补一条:

```bash
singbox-router-get-core        # 落到 ~/.local/bin/sing-box
```

包里另外装了几条命令,都是对应脚本的包装:

| 命令 | 作用 |
| --- | --- |
| `singbox-router-get-core` | 下载内核到 `~/.local/bin`(`/usr/lib` 不可写) |
| `singbox-router-get-geoip` | 下载国内自动分流用的规则集 |
| `sudo singbox-router-setup-tun` | 一次性授权 TUN(setcap + polkit) |
| `sudo singbox-router-tun-recover` | TUN 异常退出导致断网时的急救 |

卸载:

```bash
sudo apt remove singbox-router        # 保留 ~/.singbox-router
sudo apt purge  singbox-router        # 同样保留 —— 里面是你的订阅凭据,不该被卸包抹掉
```

### 两个打包上的取舍

**Node.js 列在 `Recommends` 而不是 `Depends`。** 发行版仓库里的 `nodejs` 常年落后(Ubuntu 24.04 是 18),达不到本项目要求的 20;而 nvm / nodesource 装的新版 dpkg 根本看不见。列成硬依赖只会强行拽进来一个更旧的 node。所以包里带了个 `pkg/find-node.sh`:先看 PATH,再主动翻 nvm 的目录,挑第一个主版本 ≥ 20 的。装包时会顺手体检一次,版本不够就明确打印出来。

> systemd 用户服务不读 `.zshrc`/`.bashrc`,这就是为什么必须主动去翻 nvm 目录而不能指望 PATH。

**用户级服务,不是 root 守护进程。** `systemctl --global enable` 让每个用户登录时起自己的面板后端。改系统代理、起停内核都发生在用户上下文里,不需要 root。内核是否跟着自启另有开关(默认关,见下文「开机自启」)。

## 源码目录

```bash
bash scripts/install-app.sh     # 全程不需要 root
```

## 进程架构

| 组成 | 进程 | 说明 |
| --- | --- | --- |
| **面板后端** | `node server.js` | systemd 用户服务托管,登录自启 |
| **托盘** | `app/gui.py` | 常驻遥控器,**刻意不 import WebKit** |
| **面板窗口** | `app/window.py` | 独立进程,按需启动,**关窗即退出** |
| 开始菜单入口 | — | 单实例:已在跑就激活窗口,不会冒出第二个托盘 |

依赖(`.deb` 装法由 apt 自动拉齐,源码装法手动补):

```bash
sudo apt install gir1.2-ayatanaappindicator3-0.1 gir1.2-webkit2-4.1
```

## 为什么窗口要拆成独立进程

WebKit 的库一旦 `import` 进来就**常驻约 160MB,即使销毁 webview 也不释放**。而托盘要 7×24 挂着,不能背这个包袱。

拆开后关窗是整进程退出,内存一分不留。顺带避开了另一个坑:**WebKit 用 SIGUSR1 做 GC**,而托盘正好用 SIGUSR1 接收「打开窗口」信号 —— 合在一个进程里会打日志报 `Overriding existing handler for signal 10`。

## 内存实测

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

**平时常驻省 80%。** 打开面板那几分钟才涨上去,关掉立刻回落。

两边都做了裁剪:

- **WebKit** 按「只渲染一个本地页面」配置:ephemeral WebContext + `DOCUMENT_VIEWER` 缓存档位、无 GPU 合成、无 WebGL / 媒体 / WebAudio / 磁盘缓存
- **node** 收紧 V8:`--max-old-space-size=96 --max-semi-space-size=2`(后者对 RSS 影响最明显,默认是 16MB × 3 个半空间)

> 注意 systemd 的 `Environment=` 按空格拆分,多参数**必须整体加引号**,否则第二个参数会被静默丢掉。这个坑不报错,只是内存莫名偏高。

## 形态取舍:服务 + 托盘,不是「一个窗口」

代理客户端的自然形态是后台服务 + 托盘:

- **关掉面板窗口、甚至退出托盘,都不会断网** —— 内核由服务托管,只有点「停止内核」或 `systemctl --user stop` 才会停
- 托盘只是遥控器,所有操作都走面板的本地 HTTP API,它自己不碰 sing-box
- 日常操作托盘全包了:启停内核 / 切主端口节点 / 切分流模式 / 复制节点端口 / 开面板。维护类的事(下载内核、下载规则集、授权 TUN、断网急救、重启网络、终端代理、复制诊断报告)都在「维护」子菜单里 —— 网断了、面板打不开时这条路也还在。只有改端口、导入节点、调设置才需要开面板
- 托盘标签会显示当前节点,有问题时(TUN 权限未就绪、检测到冲突、配置已变更待应用)直接标出来

## 开机自启

登录时自动拉起**面板服务 + 托盘**。内核是否也自启,由面板「设置 → 其他 → **开机自启内核**」控制,**默认关**。

勾上之后是完全静默的:

```
登录 → systemd 拉起面板服务 → 静默自启内核(含 TUN) → 托盘出现在角落
                                                    ↑ 不弹任何窗口
```

自启做了三层保护:

- **延迟 4 秒再试**,之后每 5 秒重试,最多 8 次。因为 `After=network-online.target` 并不保证真能出网,而 TUN 起来时要解析 DNS、连节点
- **区分致命错误**:权限缺失 / 与其他全局代理冲突 / 有残留路由这几种重试也没用,直接放弃并留日志,不无脑刷 8 次
- **全程静默**,只往 journal 写日志,不弹通知

> 开了自启就等于开机直接进代理状态。如果哪天节点全挂,开机会没网 —— 这时从托盘点「停止内核」即可回到直连。

## 优雅停止

注销 / 关机走的就是 `systemctl --user stop`。服务用 `KillMode=mixed` + `TimeoutStopSec=30`,只给主进程发 SIGTERM,让 `server.js` 的退出钩子依次停内核、拆 TUN、还原系统代理。

**硬杀会残留策略路由导致下次开机断网**,所以这条路径专门验证过:

```
systemctl --user stop  → 0.23s
  TUN 网卡          已消失 ✓
  9100 段策略路由   0 条残留 ✓
  路由表 2023       已空 ✓
  内核进程          0 个 ✓
  系统代理          已还原 mode=none ✓
```

## 常用命令

```bash
systemctl --user status singbox-router      # 服务状态
systemctl --user restart singbox-router     # 重启（会先优雅停内核）
journalctl --user -u singbox-router -f      # 实时日志
python3 app/gui.py                          # 手动起托盘
python3 app/window.py                       # 只开面板窗口
bash scripts/uninstall-app.sh               # 卸载集成（保留节点与设置）
```

`.deb` 装法下前三条一模一样(服务名相同),后三条换成:

```bash
python3 /usr/lib/singbox-router/app/gui.py
python3 /usr/lib/singbox-router/app/window.py
sudo apt remove singbox-router
```

卸载脚本按项目约定不用 `rm`,移除的文件统一移到 `~/.trash`,误删了还能捞回来。内核的 capability 与 polkit 规则不会被动(TUN 仍可用),脚本末尾会打印手动清理它们的命令。`.deb` 的卸载同理:不碰内核、不碰 `~/.singbox-router`。
