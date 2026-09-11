#!/usr/bin/env bash
# singbox-router 特权助手
#
# **不需要手动运行。** 面板（设置 → TUN、问题排查）和托盘菜单会通过 pkexec 调用它，
# 弹一个系统授权框，输一次密码就完事。这里只放那些**绕不开 root** 的动作：
#
#   sbr-helper.sh authorize-tun <内核绝对路径> <用户名>
#   sbr-helper.sh recover-tun   [网卡] [路由表] [规则索引起点]
#   sbr-helper.sh restart-network
#
# 为什么必须是 root：
#   · setcap 给二进制加 file capability —— 内核自身没有 root，改不了自己的 xattr
#   · /etc/polkit-1/rules.d 只有 root 能写
#   · ip rule / ip link del 改的是全局路由表
#
# 它以 root 跑，所以每个参数都在这里**再校验一遍**（调用方已经校验过一遍了）。
# 拒绝的东西一律拒绝，不做"猜测性纠正"。

set -euo pipefail

POLKIT_RULE=/etc/polkit-1/rules.d/50-singbox-router.rules

die() { printf '错误: %s\n' "$*" >&2; exit 2; }
log() { printf '%s\n' "$*"; }

[ "$(id -u)" = 0 ] || die "需要 root 权限。正常路径是面板/托盘用 pkexec 调用它，不要手动跑。"

CMD="${1:-}"
[ $# -gt 0 ] && shift

# --------------------------------------------------------------------- 参数校验

# 只接受名叫 sing-box 的绝对路径可执行文件。这是防止调用方（或任何拿到这条 pkexec
# 动作的人）用它给任意二进制加 CAP_NET_ADMIN —— 那等于一个提权后门。
check_core() {
  local core="$1"
  [ -n "$core" ] || die "缺少内核路径"
  case "$core" in
    /*) ;;
    *) die "内核路径必须是绝对路径：$core" ;;
  esac
  case "$core" in
    *..*) die "内核路径不允许包含 ..：$core" ;;
  esac
  [ "$(basename -- "$core")" = "sing-box" ] || die "只接受文件名为 sing-box 的可执行文件，收到：$core"
  [ -e "$core" ] || die "文件不存在：$core"
  [ -f "$core" ] || die "不是普通文件（可能是符号链接或目录）：$core"
  [ -x "$core" ] || die "文件不可执行：$core"
}

check_user() {
  local u="$1"
  [ -n "$u" ] || die "缺少用户名"
  printf '%s' "$u" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || die "用户名不合法：$u"
  id -- "$u" >/dev/null 2>&1 || die "系统里没有这个用户：$u"
}

check_int() {
  local v="$1" name="$2" lo="$3" hi="$4"
  case "$v" in
    ''|*[!0-9]*) die "$name 必须是整数，收到：$v" ;;
  esac
  [ "$v" -ge "$lo" ] || die "$name 超出范围（$lo-$hi）：$v"
  [ "$v" -le "$hi" ] || die "$name 超出范围（$lo-$hi）：$v"
}

# ------------------------------------------------------------- authorize-tun

authorize_tun() {
  local core="${1:-}" target="${2:-}"
  check_core "$core"
  check_user "$target"

  log "内核：$core"
  log "授权用户：$target"

  if ! command -v setcap >/dev/null 2>&1 || ! command -v getcap >/dev/null 2>&1; then
    log "系统里没有 setcap/getcap，尝试装 libcap2-bin…"
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y libcap2-bin || true
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y libcap || true
    elif command -v pacman >/dev/null 2>&1; then
      pacman -S --noconfirm libcap || true
    fi
  fi
  command -v setcap >/dev/null 2>&1 \
    || die "没有 setcap。Debian/Ubuntu/Mint: apt install libcap2-bin；Fedora: dnf install libcap；Arch: pacman -S libcap"

  log "setcap cap_net_admin,cap_net_raw+ep"
  setcap cap_net_admin,cap_net_raw+ep "$core"

  # 必须读回来确认。setcap 在 nosuid 挂载点、以及 FUSE / NTFS / exFAT 这类
  # 不支持扩展属性的文件系统上会"成功但无效" —— 那种情况下 TUN 照样起不来，
  # 得当场说清楚，而不是等启动失败再猜。
  if command -v getcap >/dev/null 2>&1; then
    local caps
    caps="$(getcap "$core" 2>/dev/null || true)"
    case "$caps" in
      *cap_net_admin*) log "✓ capability 已生效：$caps" ;;
      *)
        die "setcap 执行完了但读不回 capability。常见原因：$core 所在分区挂了 nosuid，或文件系统（FUSE / NTFS / exFAT）不支持扩展属性。把内核换到 ~/.local/bin 下再试一次。"
        ;;
    esac
  fi

  # TUN 模式下内核要通过 systemd-resolved 改这块网卡的 DNS。没有这条规则的话，
  # 每次启动/停止都会弹一次密码框 —— 那还不如不做免密。
  # 只放行四个 resolve1 动作、只对这一个用户生效，别的一概不动。
  log "写入 polkit 规则 $POLKIT_RULE"
  mkdir -p "$(dirname "$POLKIT_RULE")"
  cat > "$POLKIT_RULE" <<EOF
// singbox-router —— TUN 模式下内核要通过 systemd-resolved 设置本网卡的 DNS。
// 只放行下面四个 resolve1 动作，且只对用户 $target 生效。
// 由 scripts/sbr-helper.sh authorize-tun 生成，可以直接删掉（TUN 会退回每次弹框）。
polkit.addRule(function (action, subject) {
  var allowed = [
    "org.freedesktop.resolve1.set-dns-servers",
    "org.freedesktop.resolve1.set-domains",
    "org.freedesktop.resolve1.set-default-route",
    "org.freedesktop.resolve1.revert"
  ]
  if (subject.user === "$target" && allowed.indexOf(action.id) !== -1) {
    return polkit.Result.YES
  }
})
EOF
  chmod 644 "$POLKIT_RULE"

  log "✅ 授权完成。之后启停 TUN 都不会再要密码。"
}

# --------------------------------------------------------------- recover-tun

recover_tun() {
  local iface="${1:-sbr-tun}" table="${2:-2023}" base="${3:-9100}"

  printf '%s' "$iface" | grep -Eq '^[A-Za-z][A-Za-z0-9_-]{0,14}$' || die "网卡名不合法：$iface"
  check_int "$table" "路由表索引" 1 2147483647
  check_int "$base" "规则索引起点" 1 32000
  # 253/254/255 是 default/main/local。误删这三张表等于把整机路由清空。
  if [ "$table" -ge 253 ] && [ "$table" -le 255 ]; then
    die "路由表 $table 是系统保留表（253 default / 254 main / 255 local），拒绝操作"
  fi

  command -v ip >/dev/null 2>&1 || die "没有 ip 命令（iproute2 没装？）"

  log "清理目标：网卡 $iface / 路由表 $table / 规则索引 $base..$((base + 20))"

  local removed=0 ver pref
  for ver in -4 -6; do
    # 只删我们自己那一段索引。绝不按 "lookup 2022" 之类的通用特征扫 ——
    # 那是 sing-box 的默认值，v2rayN 等客户端正在用，删了会把别人的 TUN 打断。
    for pref in $(seq "$base" $((base + 20))); do
      while ip $ver rule show 2>/dev/null | grep -q "^${pref}:"; do
        ip $ver rule del pref "$pref" 2>/dev/null || break
        removed=$((removed + 1))
      done
    done
    while ip $ver rule show 2>/dev/null | grep -qE "lookup $table( |\$)"; do
      ip $ver rule del table "$table" 2>/dev/null || break
      removed=$((removed + 1))
    done
    ip $ver route flush table "$table" 2>/dev/null || true
  done
  log "删除策略路由 $removed 条，路由表 $table 已清空"

  if ip link show "$iface" >/dev/null 2>&1; then
    ip link del "$iface" && log "✓ 已删除残留网卡 $iface"
  else
    log "网卡 $iface 不存在（已经是干净状态）"
  fi

  # 别人的 tun/tap 一概只报告、不动手
  local others
  others="$(ip -brief link show type tun 2>/dev/null | awk '{print $1}' | sed 's/@.*//' | grep -v "^${iface}\$" || true)"
  if [ -n "$others" ]; then
    log "提示：系统里还有别的 tun 网卡（不属于本程序，未做任何处理）：$(echo "$others" | tr '\n' ' ')"
  fi

  local gw
  gw="$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')"
  if [ -n "$gw" ]; then
    if ping -c1 -W2 "$gw" >/dev/null 2>&1; then
      log "✅ 默认网关 $gw 可达，网络已恢复"
    else
      log "⚠ 默认网关 $gw 仍不可达。可以再点一次「重启网络服务」。"
    fi
  else
    log "⚠ 当前没有默认路由。可以点「重启网络服务」让 NetworkManager 重新拿一次。"
  fi
}

# ------------------------------------------------------------ restart-network

restart_network() {
  command -v systemctl >/dev/null 2>&1 || die "没有 systemctl，无法重启网络服务"
  local done_any=0
  for unit in NetworkManager systemd-networkd; do
    if systemctl list-unit-files "$unit.service" >/dev/null 2>&1 \
      && systemctl is-enabled "$unit.service" >/dev/null 2>&1; then
      log "重启 $unit…"
      systemctl restart "$unit.service" && done_any=1
    fi
  done
  [ "$done_any" = 1 ] || die "没找到正在启用的 NetworkManager / systemd-networkd"
  log "✅ 网络服务已重启"
}

# --------------------------------------------------------------------- 分发

case "$CMD" in
  authorize-tun)   authorize_tun "${1:-}" "${2:-}" ;;
  recover-tun)     recover_tun "${1:-}" "${2:-}" "${3:-}" ;;
  restart-network) restart_network ;;
  ''|*)            die "未知子命令：${CMD:-（空）}。支持：authorize-tun / recover-tun / restart-network" ;;
esac
