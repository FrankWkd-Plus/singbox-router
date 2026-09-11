#!/usr/bin/env bash
# 紧急恢复：清理 **本项目** 残留的 TUN 网卡与策略路由。
#
#   sudo bash scripts/tun-recover.sh
#   sudo bash scripts/tun-recover.sh sbr-tun 2023 9100     # 自定义了网卡名/索引时
#
# 什么时候需要它：
#   内核被 SIGKILL（kill -9）、OOM、或机器硬崩之后，sing-box 没机会执行清理，
#   auto_route 装的策略路由会留在系统里指向一块已经不存在的网卡 ——
#   表现就是整机断网。本脚本把这些规则和路由表拆掉，网络即恢复直连。
#
# 正常停止内核不需要跑这个：SIGTERM 会让 sing-box 自己清理干净。
#
# ⚠ 只动本项目的资源（默认网卡 sbr-tun、路由表 2023、规则段 9100）。
#   sing-box 的默认索引是 2022/9000，v2rayN 等其它客户端用的正是默认值 ——
#   本脚本刻意不碰它们，以免拆掉别人正在工作的 TUN。

set -euo pipefail

IFACE="${1:-sbr-tun}"
TABLE="${2:-2023}"
RULE_BASE="${3:-9100}"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m注意:\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { printf '\033[31m错误:\033[0m 需要 root，请用 sudo 运行\n' >&2; exit 1; }

log "目标：网卡 $IFACE / 路由表 $TABLE / 规则段 ${RULE_BASE}-$((RULE_BASE + 20))"
echo
log "清理前的策略路由："
ip rule show | grep -vE '^(0|32766|32767):' || echo "  (无自定义规则)"
echo

# ---- 拆策略路由：只删我们索引段内的，以及明确引用我们网卡/表的 ----
removed=0
for pref in $(seq "$RULE_BASE" $((RULE_BASE + 20))); do
  for ver in "-4" "-6"; do
    while ip $ver rule show 2>/dev/null | grep -qE "^${pref}:"; do
      ip $ver rule del pref "$pref" 2>/dev/null || break
      removed=$((removed + 1))
    done
  done
done

for ver in "-4" "-6"; do
  while ip $ver rule show 2>/dev/null | grep -q "lookup $TABLE"; do
    ip $ver rule del table "$TABLE" 2>/dev/null || break
    removed=$((removed + 1))
  done
done
log "已删除 $removed 条策略路由"

# ---- 清路由表 ----
ip route flush table "$TABLE" 2>/dev/null && log "已清空 IPv4 路由表 $TABLE" || true
ip -6 route flush table "$TABLE" 2>/dev/null && log "已清空 IPv6 路由表 $TABLE" || true

# ---- 删网卡 ----
if ip link show "$IFACE" >/dev/null 2>&1; then
  ip link del "$IFACE" && log "已删除网卡 $IFACE"
else
  log "网卡 $IFACE 不存在，无需删除"
fi

# 其它客户端的 TUN：只报告，绝不处理
others="$(ip -brief link show 2>/dev/null | awk '{print $1}' | grep -iE 'tun|tap' | grep -v "^$IFACE$" || true)"
if [ -n "$others" ]; then
  warn "发现其它 TUN 网卡（不属于本项目，未处理）：$(echo "$others" | tr '\n' ' ')"
  warn "若它属于 v2rayN / v2rayA 等客户端且正在使用，请勿手动删除。"
fi

echo
log "清理后的策略路由："
ip rule show | grep -vE '^(0|32766|32767):' || echo "  (无自定义规则)"

echo
log "连通性检查："
GW="$(ip route show default 2>/dev/null | awk '/default/{print $3; exit}')"
if [ -n "$GW" ] && ping -c 1 -W 3 "$GW" >/dev/null 2>&1; then
  printf '\033[32m  ✅ 网关 %s 可达\033[0m\n' "$GW"
else
  warn "网关不可达。检查 'ip route show default' 是否还有默认路由；"
  warn "若默认路由也丢了，重启网络：sudo systemctl restart NetworkManager"
fi
