#!/usr/bin/env bash
# 下载 sing-box 内核到 ./bin/sing-box
#
# 用法：
#   bash scripts/get-core.sh                 # 自动取最新正式版
#   SB_VERSION=1.12.4 bash scripts/get-core.sh
#   SB_MIRROR=https://ghfast.top/ bash scripts/get-core.sh    # GitHub 不通时走镜像
#   https_proxy=http://127.0.0.1:10814 bash scripts/get-core.sh
#
# 注：本项目生成的配置使用 sing-box 1.12+ 的 schema（新版 DNS server、action 字段、
#     远程 .srs 规则集），低于 1.12 的内核会因未知字段而启动失败。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/bin"
FALLBACK_VERSION="1.12.4"
MIRROR="${SB_MIRROR:-}"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || die "需要 curl"
command -v tar  >/dev/null || die "需要 tar"

# ------------------------------------------------------------------ 架构判定
case "$(uname -m)" in
  x86_64|amd64)  ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l)        ARCH=armv7 ;;
  i386|i686)     ARCH=386   ;;
  *) die "不支持的架构：$(uname -m)" ;;
esac

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
[ "$OS" = "linux" ] || log "注意：当前系统是 $OS，脚本主要面向 Linux"

# ------------------------------------------------------------------ 版本确定
VERSION="${SB_VERSION:-}"
if [ -z "$VERSION" ]; then
  log "查询最新版本…"
  API="https://api.github.com/repos/SagerNet/sing-box/releases/latest"
  VERSION="$(curl -fsSL --connect-timeout 15 "$API" 2>/dev/null \
    | grep -m1 '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/' || true)"
  if [ -z "$VERSION" ]; then
    log "查询失败，回退到已知稳定版 $FALLBACK_VERSION"
    VERSION="$FALLBACK_VERSION"
  fi
fi
VERSION="${VERSION#v}"
log "目标版本：v$VERSION  架构：$OS-$ARCH"

# 1.12 之前的 schema 不兼容，提前拦一下
MAJOR="${VERSION%%.*}"
REST="${VERSION#*.}"
MINOR="${REST%%.*}"
if [ "$MAJOR" -eq 1 ] 2>/dev/null && [ "$MINOR" -lt 12 ] 2>/dev/null; then
  die "本项目需要 sing-box >= 1.12（当前指定 $VERSION）"
fi

# ------------------------------------------------------------------ 下载解压
NAME="sing-box-${VERSION}-${OS}-${ARCH}"
URL="${MIRROR}https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${NAME}.tar.gz"

TMP="$(mktemp -d)"
log "下载 $URL"
if ! curl -fL --connect-timeout 20 --retry 2 -o "$TMP/sb.tar.gz" "$URL"; then
  die "下载失败。可尝试：SB_MIRROR=https://ghfast.top/ 或设置 https_proxy 后重试"
fi

log "解压…"
tar -xzf "$TMP/sb.tar.gz" -C "$TMP"

SRC="$(find "$TMP" -type f -name sing-box -perm -u+x | head -n1)"
[ -n "$SRC" ] || die "压缩包里没找到 sing-box 可执行文件"

mkdir -p "$BIN"
mv -f "$SRC" "$BIN/sing-box"
chmod +x "$BIN/sing-box"

# 按项目约定不用 rm，临时目录移到回收站
TRASH="$HOME/.trash"
mkdir -p "$TRASH"
mv "$TMP" "$TRASH/singbox-download-$(date +%s)" 2>/dev/null || true

log "完成：$BIN/sing-box"
"$BIN/sing-box" version
