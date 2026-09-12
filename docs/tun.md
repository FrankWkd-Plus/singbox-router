# TUN 全局代理

系统代理只对「主动读取它」的程序有效。要让**所有**程序都走代理,就得用 TUN。

## 哪些程序不认系统代理

| 程序 | 认系统代理 | 怎么办 |
| --- | --- | --- |
| Chrome / Firefox | ✅ | 无需额外配置 |
| **Telegram Desktop** | ❌ | 手动填 SOCKS5 `127.0.0.1:7890`,或填某节点的独立端口把 TG 钉死在该节点 |
| curl / git / npm | ❌ | `source ~/.singbox-router/proxy-env.sh`,或各自配 proxy |
| 其它 GUI 程序 | 不一定 | 用 TUN 一网打尽 |

## 启用

```bash
bash scripts/setup-tun.sh     # 一次性授权,需要输一次 sudo 密码
```

然后面板「设置 → TUN 全局代理」勾选启用 → 应用配置 → 启动。

**之后启停内核都不再需要任何密码。** 脚本做两件事:

**1. `setcap cap_net_admin,cap_net_raw+ep`**

让内核能建网卡、改路由表,而不必整个进程跑 root。只给这一个二进制、只给这两项能力。

> 重新下载内核(`get-core.sh`)会覆盖二进制,capability 随之丢失,需再跑一次 `setup-tun.sh`。

**2. 装一条 polkit 规则**

这一条经常被漏掉:TUN 起来后 sing-box 会调 `resolvectl` 配置该网卡的 DNS,走的是 systemd-resolved 的 **D-Bus 接口 —— 需要 polkit 授权,跟 CAP_NET_ADMIN 完全无关**。

不处理的话每次启动弹 3 次密码框(`set-domains` / `set-default-route` / `set-dns-servers`),停止时还有 1 次(`revert`)。规则只对当前用户放行这四个动作:

```
/etc/polkit-1/rules.d/50-singbox-router.rules
```

删掉该文件即恢复默认行为。放权范围可以自己验:

```bash
pkcheck --action-id org.freedesktop.resolve1.set-dns-servers --process $$   # 应通过
pkcheck --action-id org.freedesktop.systemd1.manage-units   --process $$   # 应仍需授权
```

## 三道启动前置检查

TUN 配错会直接导致**整机断网**,所以这三项任一不满足都拦在启动前,并给出具体修复命令:

| 检查 | 内容 |
| --- | --- |
| **权限** | 内核有没有 `CAP_NET_ADMIN`(或以 root 运行) |
| **冲突** | 有没有别的全局代理在跑。自动识别 **v2rayA**(iptables/tproxy)、**v2rayN**(sing-box TUN)、Clash / Mihomo |
| **残留** | 上次是不是被 `kill -9` 过,留下了指向已消失网卡的策略路由 |

开启 TUN 时会**自动跳过系统代理接管** —— TUN 已经全局捕获,再叠一层只会让人误判问题出在哪。

## 刻意错开路由表索引

sing-box 的 `auto_route` 默认用**路由表 2022、规则段 9000**。v2rayN 等其它 sing-box 客户端用的正是这套默认值,两边同时开会互相覆盖对方的策略路由 —— 现象是对方的内核被打断、反复弹 sudo 授权框,DNS 也跟着崩。

所以本项目**刻意错开**:

| | 网卡 | 路由表 | 规则段 |
| --- | --- | --- | --- |
| v2rayN / 其它 sing-box 客户端(默认值) | `singbox_tun` | 2022 | 9000 |
| **本项目** | `sbr-tun` | **2023** | **9100** |

两个好处:

1. 内核层面不再互相覆盖
2. `tun-recover.sh` 只清理 9100 段和表 2023,**绝不会拆掉别人正在工作的 TUN**。残留检测同理,只认我们自己的网卡名和索引段,不会把别人的活动规则误判成我们的残留

> 逻辑上两个全局代理仍然不能同时**生效**,这由上面的冲突检查拦住。错开索引解决的是「互相破坏」,不是「可以共存」。

## DNS 双重劫持

TUN 模式下除了 `protocol: dns`,还额外加一条 `port: 53` 规则:

```jsonc
{ "protocol": "dns", "action": "hijack-dns" },
{ "port": 53,        "action": "hijack-dns" }   // 仅 TUN
```

`protocol: dns` 依赖嗅探结果,不是 100% 可靠;`port: 53` 是确定性的。两条一起才能保证 DNS 一定被接管,不会漏到系统解析器去超时。

同理,TUN 入站必须被 `sniff` —— TUN 收到的是裸 IP 包,不嗅探就拿不到域名,日志和 DNS 行为都会变差。

## 万一断网了

内核被 `kill -9`、OOM 或机器硬崩时,sing-box 没机会清理 `auto_route` 装的策略路由,它们会指向一块已不存在的网卡 —— 表现就是整机断网。

> 正常 SIGTERM 停止不会有这个问题,`systemctl --user stop` 走的就是 SIGTERM。

```bash
sudo bash scripts/tun-recover.sh
```

拆掉 9100 段策略路由、清空路由表 2023、删除 `sbr-tun` 网卡,最后自动 ping 网关确认恢复。**只动本项目的资源**,发现其它客户端的 TUN 只提示、不擅自处理。

## TUN 与每节点端口共存

两者互不干扰,可以同时用:

- **TUN** 捕获全局流量 → 走 `proxy` 选择器(所选节点)
- **每节点独立端口** 依然是显式代理入口 → 指向它的程序固定走那个节点
- **虚拟【直连】节点** 的端口照样直连

自检里有专门几条断言,确认开 TUN 后节点直绑与直连节点仍然优先于 `clash_mode`。
