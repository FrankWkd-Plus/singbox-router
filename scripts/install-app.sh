#!/usr/bin/env bash
# 把 singbox-router 装成桌面应用：
#
#   bash scripts/install-app.sh
#
#   · systemd 用户服务托管面板后端（优雅停止，SIGTERM 让内核自己拆干净 TUN）
#   · 原生 GUI 进程：托盘 + WebKitGTK 面板窗口，二合一
#   · 开始菜单入口
#   · 登录时自动启动「面板服务 + 托盘」，但**不自动启动内核** —— 内核由你手动点
#
# 不用 Chromium 也不用 Electron：面板窗口走 WebKitGTK，渲染的是同一套 web UI，
# 外观一行不改，但内存从 742MB 降到约 180MB。
#
# 全程不需要 root。卸载：bash scripts/uninstall-app.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ID=singbox-router
ICON=network-vpn

UNIT_DIR="$HOME/.config/systemd/user"
DESKTOP_DIR="$HOME/.local/share/applications"
AUTOSTART_DIR="$HOME/.config/autostart"
BIN_DIR="$HOME/.local/bin"
GUI="$ROOT/app/gui.py"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

# systemd 用户服务不会读 .zshrc/.bashrc，nvm 装的 node 必须写绝对路径
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "找不到 node"
[ -f "$ROOT/server.js" ] || die "$ROOT 下没有 server.js"
[ -f "$GUI" ] || die "找不到 $GUI"
log "node: $NODE"

python3 - <<'PY' 2>/dev/null || die "缺少 GUI 依赖，请安装：sudo apt install gir1.2-ayatanaappindicator3-0.1 gir1.2-webkit2-4.1"
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
try:
    gi.require_version('AyatanaAppIndicator3', '0.1')
except ValueError:
    gi.require_version('AppIndicator3', '0.1')
PY
log "GUI 依赖就绪（GTK3 + WebKitGTK 4.1 + AppIndicator）"

mkdir -p "$UNIT_DIR" "$DESKTOP_DIR" "$AUTOSTART_DIR" "$BIN_DIR"

# ------------------------------------------------------------ 面板后端服务
log "写入 systemd 用户服务…"
cat > "$UNIT_DIR/$APP_ID.service" <<EOF
[Unit]
Description=singbox-router 面板后端
Documentation=file://$ROOT/README.md
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/server.js

# 收紧 V8 内存：这就是个小 HTTP 服务，用不到默认的大堆和大新生代。
# --max-semi-space-size 对 RSS 影响最明显（默认 16MB × 3 个半空间）。
# 注意必须整体加引号：systemd 的 Environment= 按空格拆分，不加引号第二个参数会被丢掉。
Environment="NODE_OPTIONS=--max-old-space-size=96 --max-semi-space-size=2"

Restart=on-failure
RestartSec=3

# 只给主进程发 SIGTERM，让 server.js 的退出钩子有机会
# 依次停内核、拆 TUN、还原系统代理。硬杀会残留策略路由导致断网。
KillMode=mixed
KillSignal=SIGTERM
TimeoutStopSec=30

StandardOutput=journal
StandardError=journal
SyslogIdentifier=$APP_ID

[Install]
WantedBy=default.target
EOF

# ------------------------------------------------------------------ 启动器
log "写入启动器 $BIN_DIR/$APP_ID…"
cat > "$BIN_DIR/$APP_ID" <<EOF
#!/usr/bin/env bash
# 打开面板窗口。后端没起来就先拉起来；GUI 已在运行就让它开窗，不再起第二个托盘。
set -e
systemctl --user start $APP_ID.service 2>/dev/null || true

PORT=8899
STATE="$ROOT/data/state.json"
if [ -f "\$STATE" ]; then
  P="\$($NODE -e "try{console.log(JSON.parse(require('fs').readFileSync('\$STATE')).settings.webPort)}catch(e){}" 2>/dev/null || true)"
  [ -n "\$P" ] && PORT="\$P"
fi

# 等后端就绪（最多 10 秒）
for _ in \$(seq 1 40); do
  if (exec 3<>/dev/tcp/127.0.0.1/\$PORT) 2>/dev/null; then break; fi
  sleep 0.25
done

# 单实例：已有 GUI 进程就发 SIGUSR1 让它开窗
PIDS="\$(pgrep -f "python3 $GUI" || true)"
if [ -n "\$PIDS" ]; then
  kill -USR1 \$PIDS
else
  exec python3 "$GUI" --window
fi
EOF
chmod +x "$BIN_DIR/$APP_ID"

# ------------------------------------------------------------- 开始菜单入口
log "写入桌面入口…"
cat > "$DESKTOP_DIR/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=singbox-router
Comment=基于 sing-box 的分流客户端
Exec=$BIN_DIR/$APP_ID
Icon=$ICON
Terminal=false
Categories=Network;
StartupWMClass=singbox-router
Keywords=proxy;vpn;singbox;分流;
EOF

# --------------------------------------------------------------- 托盘自启
log "写入托盘自启项…"
cat > "$AUTOSTART_DIR/$APP_ID-tray.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=singbox-router 托盘
Comment=singbox-router 托盘常驻（不自动开窗）
Exec=python3 $GUI
Icon=$ICON
Terminal=false
X-GNOME-Autostart-enabled=true
# 等桌面与托盘区域就绪
X-GNOME-Autostart-Delay=8
EOF

# ------------------------------------------------------------------ 启用
log "启用并启动服务…"
systemctl --user daemon-reload
systemctl --user enable "$APP_ID.service" >/dev/null
systemctl --user restart "$APP_ID.service"

sleep 2
if systemctl --user is-active --quiet "$APP_ID.service"; then
  log "面板服务已运行"
else
  printf '\033[33m注意:\033[0m 服务未能启动，看日志： journalctl --user -u %s -n 30\n' "$APP_ID"
fi

command -v update-desktop-database >/dev/null && update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

# 重启 GUI：装两次不要出现两个托盘图标
pkill -f "python3 $GUI" 2>/dev/null || true
pkill -f "python3 $ROOT/app/tray.py" 2>/dev/null || true
sleep 0.5
nohup python3 "$GUI" >/dev/null 2>&1 &

cat <<EOF

$(printf '\033[32m✅ 安装完成\033[0m')

  开始菜单        搜索 "singbox-router" 打开面板窗口（WebKitGTK，非 Chromium）
  托盘图标        右上角常驻，可启停内核 / 切节点 / 切模式 / 开面板
  开机自启        面板服务 + 托盘会自动启动，**内核不自动启动**（你自己点）

  服务管理
    systemctl --user status $APP_ID
    systemctl --user restart $APP_ID
    journalctl --user -u $APP_ID -f

  卸载            bash scripts/uninstall-app.sh

  说明：关掉面板窗口只销毁 webview（内存立刻释放），托盘留着，内核不受影响。

EOF
