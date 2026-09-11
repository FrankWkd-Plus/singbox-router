#!/usr/bin/env bash
# 打成 .deb —— 装完就是一个正常的桌面应用，不是一个要 cd 进去 node server.js 的目录。
#
#   bash scripts/build-deb.sh
#   SBR_DEB_REV=2 bash scripts/build-deb.sh          # 同版本再发一次
#   SBR_VERSION=1.1.0 bash scripts/build-deb.sh      # 覆盖 package.json 里的版本
#
# 产物：dist/singbox-router_<版本>-<修订>_all.deb
#
# 装到哪些位置：
#   /usr/lib/singbox-router/          程序本体（只读，不产生任何运行期数据）
#   /usr/bin/singbox-router           打开面板窗口
#   /usr/bin/singbox-router-{get-core,get-geoip,setup-tun,tun-recover}
#   /usr/lib/systemd/user/….service   面板后端（用户级服务，不是 root 守护进程）
#   /usr/share/applications/….desktop 开始菜单
#   /etc/xdg/autostart/…-tray.desktop 登录时起托盘
#   /usr/share/doc/singbox-router/    README 与 docs/
#
# 架构写 all：整个程序是 Node + Python，没有一行编译产物。sing-box 内核不打进包里
# ——它几十 MB、按架构分发、且需要单独 setcap，装完用 singbox-router-get-core 拉。
#
# 按项目约定不用 rm：重复构建时旧的暂存目录移到 ~/.trash。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ID=singbox-router
ARCH=all
PREFIX="/usr/lib/$APP_ID"
DOCDIR="/usr/share/doc/$APP_ID"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m注意:\033[0m %s\n' "$*"; }
die()  { printf '\033[31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

command -v dpkg-deb >/dev/null || die "需要 dpkg-deb（sudo apt install dpkg-dev）"
command -v md5sum   >/dev/null || die "需要 md5sum"
command -v gzip     >/dev/null || die "需要 gzip"
command -v tar      >/dev/null || die "需要 tar"

# ------------------------------------------------------------------ 版本与身份
VERSION="${SBR_VERSION:-$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n1)}"
[ -n "$VERSION" ] || die "从 package.json 里没读到 version"
REV="${SBR_DEB_REV:-1}"
FULLVER="$VERSION-$REV"

# Maintainer 是 control 的必填字段。优先用本机 git 身份，读不到就用一个占位值，
# 不硬编码任何人的邮箱。
GIT_NAME="$(git -C "$ROOT" config user.name  2>/dev/null || true)"
GIT_MAIL="$(git -C "$ROOT" config user.email 2>/dev/null || true)"
MAINTAINER="${SBR_MAINTAINER:-${GIT_NAME:-singbox-router} <${GIT_MAIL:-noreply@localhost}>}"

OUT="$ROOT/dist"
PKG="$OUT/pkgroot"
DEB="$OUT/${APP_ID}_${FULLVER}_${ARCH}.deb"

log "版本 $FULLVER  架构 $ARCH"
log "Maintainer: $MAINTAINER"

# ------------------------------------------------------------------ 暂存目录
mkdir -p "$OUT"
if [ -e "$PKG" ]; then
  TRASH="$HOME/.trash"
  mkdir -p "$TRASH"
  mv "$PKG" "$TRASH/${APP_ID}-pkgroot-$(date +%s)"
  log "旧暂存目录已移到回收站"
fi

mkdir -p \
  "$PKG/DEBIAN" \
  "$PKG$PREFIX" \
  "$PKG$PREFIX/pkg" \
  "$PKG/usr/bin" \
  "$PKG/usr/lib/systemd/user" \
  "$PKG/usr/share/applications" \
  "$PKG/etc/xdg/autostart" \
  "$PKG$DOCDIR"

# ------------------------------------------------------------------ 程序本体
log "复制程序文件…"
cp -a "$ROOT/server.js" "$ROOT/package.json" "$PKG$PREFIX/"
# 用 tar 转运而不是 cp -a：好剔掉 __pycache__ / *.pyc。
# （按项目约定不用 rm，所以宁可一开始就不复制，而不是复制完再删。）
tar -C "$ROOT" --exclude=__pycache__ --exclude='*.pyc' -cf - src public app \
  | tar -C "$PKG$PREFIX" -xf -

# scripts/ 里除了 install-app.sh / uninstall-app.sh 都带上。
# 那两个是 git clone 装法专用的：两边的单元与 autostart 项文件名相同，用户目录
# 那份会盖住系统目录那份，装了 .deb 再跑一次它，dpkg 装的这份就变哑的了。
mkdir -p "$PKG$PREFIX/scripts"
for f in "$ROOT"/scripts/*; do
  case "$(basename "$f")" in
    install-app.sh|uninstall-app.sh) continue ;;
  esac
  cp -a "$f" "$PKG$PREFIX/scripts/"
done

# 文档按 Debian 惯例放 /usr/share/doc（程序目录只留代码）
cp -a "$ROOT/README.md" "$ROOT/README.en.md" "$ROOT/docs" "$PKG$DOCDIR/"
cp -a "$ROOT/LICENSE" "$PKG$DOCDIR/copyright"

cat > "$PKG$DOCDIR/README.Debian" <<EOF
singbox-router（.deb 装法）
==========================

程序在 $PREFIX，只读；所有运行期数据（设置、节点、订阅 token、规则集、内核缓存）
都在各用户自己的 ~/.config/$APP_ID 下。卸载与 purge 都不会碰它。

装完还差一个内核：

    singbox-router-get-core                       # 落到 ~/.local/bin/sing-box
    SB_MIRROR=https://ghfast.top/ singbox-router-get-core   # GitHub 不通时

可选：

    singbox-router-get-geoip     下载国内自动分流用的规则集
    singbox-router-setup-tun     一次性授权 TUN（setcap + polkit，需要 sudo）
    singbox-router-tun-recover   TUN 异常退出导致断网时的急救（需要 sudo）

面板后端是**用户级** systemd 服务（不是 root 守护进程）：

    systemctl --user status $APP_ID
    journalctl --user -u $APP_ID -f

安装时已 systemctl --global enable，登录即起。不想自启：

    systemctl --user disable $APP_ID     # 面板后端，只对自己生效

托盘那条自启项在 /etc/xdg/autostart/$APP_ID-tray.desktop。要关掉它，用桌面的
「启动应用程序」取消勾选（会在 ~/.config/autostart 生成一份带 Hidden=true 的覆盖），
或者自己复制一份到 ~/.config/autostart 并加上 Hidden=true —— 别去改 /etc 里那份，
升级时 dpkg 会因为它是 conffile 而来问你。

包里刻意不含 scripts/install-app.sh —— 那是 git clone 装法用的。两边的单元与
autostart 项文件名相同，用户目录那份会盖住系统目录那份，于是这个包装的那份变哑的；
之后把 clone 目录挪走，服务还指着它。
EOF

cat > "$PKG$DOCDIR/changelog.Debian" <<EOF
$APP_ID ($FULLVER) unstable; urgency=medium

  * 打包发布。运行期数据移到 ~/.config/$APP_ID，程序目录只读。
  * 新增：自定义分流规则（进程 / IP / 域名，域名与进程路径支持正则）。
  * 新增：国内自动分流（GeoIP + GeoSite，默认关）。
  * 新增：打开配置文件夹（面板按钮与托盘菜单各一条路）。

 -- $MAINTAINER  $(date -R)
EOF
gzip -9n "$PKG$DOCDIR/changelog.Debian"

# ------------------------------------------------------- node 定位（包内共用）
#
# 这个文件是整个包里最容易被低估的一块。systemd 用户服务不读 .zshrc/.bashrc，
# 所以 nvm 装的 node 根本不在 PATH 里；而发行版仓库里的 nodejs 又常年落后
# （Ubuntu 24.04 是 18），达不到本项目要求的 20。硬写 /usr/bin/node 会挑中那个旧的。
# 所以：先在 PATH 里找，再主动翻 nvm 的目录，取第一个主版本 >= 20 的。
cat > "$PKG$PREFIX/pkg/find-node.sh" <<'EOF'
#!/usr/bin/env bash
# 找一个可用的 node（主版本 >= 20 优先）。可 source 后用 sbr_find_node，
# 也可直接跑：find-node.sh --print
#
# 顺序：$SBR_NODE > PATH > nvm(default alias, 然后版本号最大) > /usr/bin > /usr/local/bin

sbr_node_major() {
  "$1" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || true
}

sbr_find_node() {
  local c m nvm a
  local cands=()

  [ -n "${SBR_NODE:-}" ] && cands+=("$SBR_NODE")
  c="$(command -v node 2>/dev/null || true)"
  [ -n "$c" ] && cands+=("$c")

  nvm="${NVM_DIR:-$HOME/.nvm}"
  if [ -d "$nvm/versions/node" ]; then
    if [ -r "$nvm/alias/default" ]; then
      a="$(cat "$nvm/alias/default" 2>/dev/null || true)"
      [ -n "$a" ] && cands+=("$nvm/versions/node/v${a#v}/bin/node")
    fi
    while IFS= read -r c; do
      [ -n "$c" ] && cands+=("$c")
    done < <(ls -d "$nvm"/versions/node/v*/bin/node 2>/dev/null | sort -Vr)
  fi

  cands+=(/usr/bin/node /usr/local/bin/node)

  # 先要够新的
  for c in "${cands[@]}"; do
    [ -x "$c" ] || continue
    m="$(sbr_node_major "$c")"
    case "$m" in ''|*[!0-9]*) continue ;; esac
    if [ "$m" -ge 20 ]; then printf '%s' "$c"; return 0; fi
  done
  # 一个都不够新：退回任何能跑的。让程序自己在启动时报版本错，
  # 比这里静默什么都不做更容易排查。
  for c in "${cands[@]}"; do
    if [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

if [ "${1:-}" = "--print" ]; then
  sbr_find_node || exit 1
  echo
fi
EOF

# ----------------------------------------------------------- 后端启动器（服务用）
cat > "$PKG/usr/bin/$APP_ID-server" <<EOF
#!/usr/bin/env bash
# 面板后端。由 $APP_ID.service 拉起，也可以手动跑来看输出。
set -euo pipefail
. $PREFIX/pkg/find-node.sh
NODE="\$(sbr_find_node || true)"
if [ -z "\$NODE" ]; then
  echo "找不到 node。需要 Node.js >= 20：sudo apt install nodejs，或用 nvm 装。" >&2
  exit 127
fi
cd $PREFIX
# exec：让 node 成为 MAINPID，SIGTERM 直达它的退出钩子
# （要停内核、拆 TUN、还原系统代理，硬杀会残留策略路由导致断网）
exec "\$NODE" $PREFIX/server.js "\$@"
EOF

# --------------------------------------------------------------- 面板启动器
cat > "$PKG/usr/bin/$APP_ID" <<EOF
#!/usr/bin/env bash
# 打开面板窗口。后端没起就先起；托盘已在跑就让它开窗，不再起第二个托盘。
set -e
GUI=$PREFIX/app/gui.py

systemctl --user start $APP_ID.service 2>/dev/null || true

# 端口从状态文件里读。用 python3 而不是 node：python3 是本包的硬依赖，
# 而 node 可能装在 nvm 里，为读一个整数去解析 nvm 目录不值得。
PORT=8899
STATE="\${XDG_CONFIG_HOME:-\$HOME/.config}/$APP_ID/state.json"
if [ -f "\$STATE" ]; then
  P="\$(python3 -c "import json,sys
try: print(json.load(open(sys.argv[1]))['settings']['webPort'])
except Exception: pass" "\$STATE" 2>/dev/null || true)"
  [ -n "\$P" ] && PORT="\$P"
fi

# 等后端就绪（最多 10 秒）
for _ in \$(seq 1 40); do
  if (exec 3<>/dev/tcp/127.0.0.1/\$PORT) 2>/dev/null; then break; fi
  sleep 0.25
done

PIDS="\$(pgrep -f "python3 \$GUI" || true)"
if [ -n "\$PIDS" ]; then
  kill -USR1 \$PIDS          # 单实例：让已有托盘开窗
else
  exec python3 "\$GUI" --window
fi
EOF

# ------------------------------------------------------------ 脚本包装器
# /usr/lib 不可写，所以内核落到 ~/.local/bin —— src/core.js 的 findCore 本来就找那里。
cat > "$PKG/usr/bin/$APP_ID-get-core" <<EOF
#!/usr/bin/env bash
# 下载 sing-box 内核到 ~/.local/bin（程序目录在 /usr/lib 下不可写）
set -euo pipefail
mkdir -p "\$HOME/.local/bin"
export SB_BIN_DIR="\${SB_BIN_DIR:-\$HOME/.local/bin}"
exec bash $PREFIX/scripts/get-core.sh "\$@"
EOF

cat > "$PKG/usr/bin/$APP_ID-get-geoip" <<EOF
#!/usr/bin/env bash
# 下载国内自动分流用的 GeoIP / GeoSite 规则集到 ~/.config/$APP_ID/rulesets
set -euo pipefail
exec bash $PREFIX/scripts/get-geoip.sh "\$@"
EOF

cat > "$PKG/usr/bin/$APP_ID-setup-tun" <<EOF
#!/usr/bin/env bash
# 一次性授权 TUN（setcap + polkit），需要 sudo
set -euo pipefail
exec bash $PREFIX/scripts/setup-tun.sh "\$@"
EOF

cat > "$PKG/usr/bin/$APP_ID-tun-recover" <<EOF
#!/usr/bin/env bash
# TUN 异常退出导致断网时的急救。需要 root：sudo $APP_ID-tun-recover
set -euo pipefail
exec bash $PREFIX/scripts/tun-recover.sh "\$@"
EOF

# --------------------------------------------------------------- systemd 服务
# 放 /usr/lib/systemd/user：这是**用户级**服务，跟着登录会话起，
# 不是 root 守护进程。改系统代理、起停内核都发生在用户上下文里。
cat > "$PKG/usr/lib/systemd/user/$APP_ID.service" <<EOF
[Unit]
Description=singbox-router 面板后端
Documentation=file://$DOCDIR/README.md
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$PREFIX
ExecStart=/usr/bin/$APP_ID-server

# 收紧 V8 内存：这就是个小 HTTP 服务，用不到默认的大堆和大新生代。
# 必须整体加引号：Environment= 按空格拆分，不加引号第二个参数会被丢掉。
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

# ------------------------------------------------------------------ 桌面入口
cat > "$PKG/usr/share/applications/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=singbox-router
Comment=基于 sing-box 的分流客户端
Comment[en]=sing-box based proxy router
Exec=/usr/bin/$APP_ID
Icon=network-vpn
Terminal=false
Categories=Network;
StartupWMClass=singbox-router
Keywords=proxy;vpn;singbox;分流;
EOF

cat > "$PKG/etc/xdg/autostart/$APP_ID-tray.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=singbox-router 托盘
Comment=singbox-router 托盘常驻（不自动开窗）
Exec=python3 $PREFIX/app/gui.py
Icon=network-vpn
Terminal=false
X-GNOME-Autostart-enabled=true
# 等桌面与托盘区域就绪
X-GNOME-Autostart-Delay=8
EOF

# ------------------------------------------------------------------ 权限
log "设置权限…"
find "$PKG" -type d -exec chmod 755 {} +
find "$PKG" -type f -exec chmod 644 {} +
chmod 755 "$PKG/usr/bin/"*
chmod 755 "$PKG$PREFIX/pkg/find-node.sh"
chmod 755 "$PKG$PREFIX"/scripts/*.sh
chmod 644 "$PKG$PREFIX"/scripts/*.mjs

# ------------------------------------------------------------------ 控制信息
INSTALLED_KB="$(du -ks --exclude=DEBIAN "$PKG" | cut -f1)"

cat > "$PKG/DEBIAN/control" <<EOF
Package: $APP_ID
Version: $FULLVER
Section: net
Priority: optional
Architecture: $ARCH
Maintainer: $MAINTAINER
Installed-Size: $INSTALLED_KB
Depends: python3 (>= 3.8), python3-gi, gir1.2-gtk-3.0, gir1.2-webkit2-4.1, gir1.2-ayatanaappindicator3-0.1 | gir1.2-appindicator3-0.1, curl, procps
Recommends: nodejs (>= 20), xdg-utils, libcap2-bin
Suggests: sing-box
Homepage: https://github.com/FrankWkd-Plus/singbox-router
Description: 基于 sing-box 的分流客户端（Web 面板 + 托盘）
 订阅与多格式节点导入、每节点独立端口分流、系统代理接管、TUN 全局代理、
 自定义分流规则（进程 / IP / 域名，支持正则）、国内自动分流。
 .
 面板是本机 HTTP 服务 + WebKitGTK 窗口（不是 Electron，常驻内存约 182MB）。
 后端以**用户级** systemd 服务运行，不需要 root。
 .
 需要 Node.js >= 20。发行版仓库里的 nodejs 常年落后，本包因此把它列为
 Recommends 而非 Depends：用 nvm / nodesource 装了新版的话，
 --no-install-recommends 即可，程序会自动找到它。
 .
 sing-box 内核不含在包里（按架构分发、需单独 setcap）。装完执行
 singbox-router-get-core 下载，或自行安装 sing-box >= 1.12。
EOF

# /etc 下的文件登记成 conffile：用户改过（比如加 Hidden=true 关掉托盘自启）
# 升级时 dpkg 会问，而不是直接覆盖掉。
cat > "$PKG/DEBIAN/conffiles" <<EOF
/etc/xdg/autostart/$APP_ID-tray.desktop
EOF

cat > "$PKG/DEBIAN/postinst" <<EOF
#!/bin/sh
set -e

case "\$1" in
  configure)
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database -q /usr/share/applications 2>/dev/null || true
    fi

    # 用户级服务：--global enable 让每个用户登录时自动起面板后端。
    # 内核是否跟着自启另有开关（面板「设置 → 开机自启内核」，默认关）。
    if command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload >/dev/null 2>&1 || true
      systemctl --global enable $APP_ID.service >/dev/null 2>&1 || true
    fi

    # node 体检：装不上也不让 apt 失败，但要说清楚，别让用户点了图标才发现没反应
    NODE="\$($PREFIX/pkg/find-node.sh --print 2>/dev/null || true)"
    if [ -z "\$NODE" ]; then
      echo "注意：没找到 node。singbox-router 需要 Node.js >= 20，装一个再用："
      echo "      sudo apt install nodejs   或   https://github.com/nvm-sh/nvm"
    else
      MAJOR="\$("\$NODE" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
      if [ "\$MAJOR" -lt 20 ] 2>/dev/null; then
        echo "注意：找到的 node 是 v\$MAJOR（\$NODE），低于要求的 20。"
        echo "      生成的配置用 sing-box 1.12+ 的 schema，老 node 起不来面板。"
      fi
    fi

    echo ""
    echo "singbox-router 已安装。还差一个内核："
    echo "    $APP_ID-get-core"
    echo "然后从开始菜单打开，或直接跑：$APP_ID"
    echo "说明见 $DOCDIR/README.Debian"
    echo ""
    ;;
esac

exit 0
EOF

cat > "$PKG/DEBIAN/prerm" <<EOF
#!/bin/sh
set -e

case "\$1" in
  remove|deconfigure)
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --global disable $APP_ID.service >/dev/null 2>&1 || true
    fi
    # 托盘还挂着的话，删完文件它就会指向不存在的路径。只杀我们自己的进程。
    pkill -f "python3 $PREFIX/app/" 2>/dev/null || true
    ;;
esac

exit 0
EOF

cat > "$PKG/DEBIAN/postrm" <<EOF
#!/bin/sh
set -e

case "\$1" in
  remove|purge)
    if command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database -q /usr/share/applications 2>/dev/null || true
    fi
    if [ "\$1" = purge ]; then
      # 刻意不删：那目录里是用户的订阅 token 与节点凭据，卸个包不该抹掉它。
      echo "各用户的设置与节点仍在 ~/.config/$APP_ID（含订阅凭据），dpkg 不动它。"
    fi
    ;;
esac

exit 0
EOF

chmod 755 "$PKG/DEBIAN/postinst" "$PKG/DEBIAN/prerm" "$PKG/DEBIAN/postrm"
chmod 644 "$PKG/DEBIAN/control" "$PKG/DEBIAN/conffiles"

# md5sums：dpkg-deb 不会自动生成，但 dpkg --verify 和一些工具会读它
log "生成 md5sums…"
(
  cd "$PKG"
  find . -path ./DEBIAN -prune -o -type f -print0 \
    | sort -z \
    | xargs -0 md5sum \
    | sed 's| \./| |' > DEBIAN/md5sums
)
chmod 644 "$PKG/DEBIAN/md5sums"

# ------------------------------------------------------------------ 打包
log "dpkg-deb 打包…"
# --root-owner-group：不用 fakeroot 也能让包里的文件属 root:root
dpkg-deb --root-owner-group --build "$PKG" "$DEB" >/dev/null

command -v lintian >/dev/null && {
  log "lintian（仅提示，不影响产物）…"
  lintian --no-tag-display-limit "$DEB" 2>&1 | head -30 || true
}

SIZE="$(du -h "$DEB" | cut -f1)"

cat <<EOF

$(printf '\033[32m✅ 打包完成\033[0m')  $SIZE

  $DEB

  安装        sudo apt install $DEB     # 用 apt 而不是 dpkg -i，依赖会自动装
  卸载        sudo apt remove $APP_ID
  看内容      dpkg-deb --contents $DEB

  装完还差内核： $APP_ID-get-core

  提醒：这个包**没有**在真机上装过（本轮只负责产出）。第一次装建议先
        dpkg-deb --contents 看一眼路径，再 sudo apt install。

EOF
