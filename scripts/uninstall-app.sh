#!/usr/bin/env bash
# 卸载桌面应用集成（不删项目本体、不删配置与节点数据）
#
#   bash scripts/uninstall-app.sh
#
# 按项目约定不用 rm：移除的文件统一移到 ~/.trash，误删了还能捞回来。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ID=singbox-router
TRASH="$HOME/.trash/${APP_ID}-app-$(date +%s)"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }

mkdir -p "$TRASH"

log "停止并禁用服务…"
systemctl --user stop "$APP_ID.service" 2>/dev/null || true
systemctl --user disable "$APP_ID.service" 2>/dev/null || true

log "退出托盘…"
pkill -f "python3 $ROOT/app/gui.py" 2>/dev/null || true

log "移除集成文件（移入 $TRASH）…"
for f in \
  "$HOME/.config/systemd/user/$APP_ID.service" \
  "$HOME/.local/share/applications/$APP_ID.desktop" \
  "$HOME/.config/autostart/$APP_ID-tray.desktop" \
  "$HOME/.local/bin/$APP_ID"
do
  [ -e "$f" ] && mv "$f" "$TRASH/" && log "  $(basename "$f")"
done

systemctl --user daemon-reload
command -v update-desktop-database >/dev/null && \
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

cat <<EOF

$(printf '\033[32m✅ 已卸载桌面集成\033[0m')

  项目本体、节点与设置都还在：$ROOT
  想手动运行：cd $ROOT && node server.js

  内核的 capability 与 polkit 规则没有动（TUN 仍可用）。
  要一并清掉：
    sudo setcap -r $ROOT/bin/sing-box
    sudo mv /etc/polkit-1/rules.d/50-$APP_ID.rules ~/.trash/

EOF
