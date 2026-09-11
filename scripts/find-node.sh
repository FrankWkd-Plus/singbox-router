#!/usr/bin/env bash
# 找一个可用的 node（主版本 >= 20 优先）。source 后用 sbr_find_node，
# 也可以直接跑：bash scripts/find-node.sh --print
#
# 顺序：$SBR_NODE > PATH > nvm(default 别名，然后版本号最大) > /usr/bin > /usr/local/bin
#
# 为什么需要这个文件：systemd 用户服务不读 .zshrc/.bashrc，所以 nvm 装的 node
# 根本不在 PATH 里；而发行版仓库里的 nodejs 又常年落后（Ubuntu 24.04 是 18），
# 达不到本项目要求的 20。硬写 /usr/bin/node 会正好挑中那个旧的。
#
# .deb 里这个文件被复制成 <程序目录>/pkg/find-node.sh，两边是同一份。

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
