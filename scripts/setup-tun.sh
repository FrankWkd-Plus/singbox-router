#!/usr/bin/env bash
# 一次性授权：给 sing-box 加 CAP_NET_ADMIN，让 TUN 模式无需 root 运行。
#
#   bash scripts/setup-tun.sh
#
# 为什么用 file capability 而不是每次 sudo：
#   - 只给这一个二进制、只给建网卡/改路由这两项能力，比整个进程跑 root 小得多
#   - 授权一次永久有效，面板启动内核时不再需要密码
#
# 注意：重新下载内核（get-core.sh）会覆盖二进制，capability 随之丢失，需再跑一次本脚本。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/bin/sing-box"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$CORE" ] || die "找不到内核 $CORE，请先运行 bash scripts/get-core.sh"

if ! command -v setcap >/dev/null || ! command -v getcap >/dev/null; then
  log "缺少 setcap/getcap，正在安装 libcap2-bin…"
  sudo apt-get install -y libcap2-bin || die "安装 libcap2-bin 失败，请手动安装后重试"
fi

log "当前 capability：$(getcap "$CORE" 2>/dev/null || echo '无')"
log "授权 cap_net_admin,cap_net_raw（需要 sudo 密码）…"
sudo setcap cap_net_admin,cap_net_raw+ep "$CORE"

RESULT="$(getcap "$CORE" 2>/dev/null || true)"
log "授权后：${RESULT:-无}"

printf '%s' "$RESULT" | grep -q cap_net_admin || \
  die "授权似乎未生效。若 $ROOT 挂载在 noexec/nosuid 的文件系统上，file capability 会失效，请把项目移到普通分区。"

# ---------------------------------------------------------------- polkit 免密
#
# TUN 起来后 sing-box 会调 resolvectl 配置这块网卡的 DNS，走的是 systemd-resolved
# 的 D-Bus 接口 —— 那需要 polkit 授权，跟 CAP_NET_ADMIN 无关。不处理的话
# 每次启动弹 3 次密码框（set-domains / set-default-route / set-dns-servers），
# 停止时还有 1 次（revert）。装一条规则给这四个动作免密。

POLKIT_RULE=/etc/polkit-1/rules.d/50-singbox-router.rules
TARGET_USER="${SUDO_USER:-$USER}"

if [ ! -d /etc/polkit-1/rules.d ]; then
  log "跳过 polkit 配置：本机没有 /etc/polkit-1/rules.d（可能不用 systemd-resolved）"
else
  log "安装 polkit 规则，让 $TARGET_USER 无需密码配置 TUN 网卡的 DNS…"
  sudo tee "$POLKIT_RULE" >/dev/null <<EOF
// 由 singbox-router 的 scripts/setup-tun.sh 生成
//
// sing-box 在 TUN 启停时通过 systemd-resolved 配置该网卡的 DNS，
// 这些动作默认需要交互式授权。仅对本机用户 $TARGET_USER 放行这四个动作，
// 避免每次启停都弹密码框。删除本文件即可恢复默认行为。
polkit.addRule(function (action, subject) {
  var allowed = [
    "org.freedesktop.resolve1.set-dns-servers",
    "org.freedesktop.resolve1.set-domains",
    "org.freedesktop.resolve1.set-default-route",
    "org.freedesktop.resolve1.revert"
  ];
  if (subject.user === "$TARGET_USER" && allowed.indexOf(action.id) !== -1) {
    return polkit.Result.YES;
  }
});
EOF
  sudo chmod 644 "$POLKIT_RULE"
  log "已写入 $POLKIT_RULE"
fi

printf '\n\033[32m✅ 完成。\033[0m 现在可以在面板「设置 → TUN 全局代理」里开启 TUN。\n\n'
printf '  · 启动内核不再需要密码（capability + polkit 都配好了）\n'
printf '  · 开启前请先退出其它全局代理（v2rayA / v2rayN / Clash TUN），它们会和 TUN 抢路由\n'
printf '  · 万一异常退出导致断网： sudo bash scripts/tun-recover.sh\n\n'
