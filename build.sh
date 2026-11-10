#!/usr/bin/env sh
# Codex Speed 打包脚本：生成 zip 和 tar.gz。
# 版本号从 plugin.json 读取，不会修改版本号。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT_DIR="$ROOT/dist"

usage() {
  cat <<'EOF'
用法: sh build.sh [选项]

选项:
  -o, --out DIR  输出目录（默认 dist，相对路径按仓库根目录解析）
  -h, --help     显示帮助

示例:
  sh build.sh
  sh build.sh -o ./out
EOF
}

die() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--out)
      [ "$#" -ge 2 ] || die "$1 需要一个目录参数"
      OUT_DIR=$2
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（用 --help 查看用法）" ;;
  esac
done

case "$OUT_DIR" in
  /*) ;;
  *) OUT_DIR="$ROOT/$OUT_DIR" ;;
esac
mkdir -p "$OUT_DIR"

[ -f "$ROOT/plugin.json" ] || die "找不到 plugin.json"
[ -f "$ROOT/mcp.json" ] || die "找不到 mcp.json"
command -v zip >/dev/null 2>&1 || die "找不到 zip 命令"
command -v tar >/dev/null 2>&1 || die "找不到 tar 命令"
command -v gzip >/dev/null 2>&1 || die "找不到 gzip 命令"

# zipinfo 和 unzip 二选一，用来校验 zip 内容
if command -v zipinfo >/dev/null 2>&1; then
  ZIP_LIST_CMD=zipinfo
elif command -v unzip >/dev/null 2>&1; then
  ZIP_LIST_CMD=unzip
else
  die "找不到 zipinfo/unzip，无法校验 zip"
fi

version=$(tr -d '\r' < "$ROOT/plugin.json" | sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/p' | head -n 1)
[ -n "$version" ] || die "plugin.json 里没有 version 字段"

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/codex-speed-build.XXXXXX") || die "无法创建临时目录"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

COMMON_ITEMS="LICENSE README.md plugin.json mcp.json scripts skills hooks"
REQUIRED_PATHS="codex-speed/plugin.json codex-speed/mcp.json codex-speed/scripts/mcp-server.mjs codex-speed/scripts/ui/panel.html codex-speed/skills/reasoning-speed/SKILL.md codex-speed/hooks/hooks.json"

list_zip() {
  if [ "$ZIP_LIST_CMD" = "zipinfo" ]; then
    zipinfo -1 "$1"
  else
    unzip -Z1 "$1"
  fi
}

list_archive() {
  case "$1" in
    *.zip) list_zip "$1" ;;
    *.tar.gz) tar -tzf "$1" ;;
    *) die "未知归档类型: $1" ;;
  esac
}

check_archive() {
  archive=$1
  entries=$(list_archive "$archive" | tr -d '\r' | tr '\\' '/') || die "无法读取归档: $archive"
  for path in $REQUIRED_PATHS; do
    printf '%s\n' "$entries" | grep -Fqx "$path" || die "归档 $archive 缺少 $path"
  done
}

copy_items() {
  package_root=$1
  for item in $COMMON_ITEMS; do
    [ -e "$ROOT/$item" ] || die "缺少打包文件: $item"
    cp -R "$ROOT/$item" "$package_root/"
  done
}

build_package() {
  stage="$TMP_ROOT/stage"
  package_root="$stage/codex-speed"
  zip_path="$OUT_DIR/codex-speed-$version.zip"
  tar_path="$OUT_DIR/codex-speed-$version.tar.gz"

  mkdir -p "$package_root"
  copy_items "$package_root"

  rm -f "$zip_path" "$tar_path"
  (cd "$stage" && zip -qr "$zip_path" codex-speed) || die "zip 打包失败: $zip_path"
  tar -czf "$tar_path" -C "$stage" codex-speed || die "tar 打包失败: $tar_path"

  check_archive "$zip_path"
  check_archive "$tar_path"

  printf '  %s (%s bytes)\n' "$zip_path" "$(wc -c < "$zip_path" | tr -d ' ')"
  printf '  %s (%s bytes)\n' "$tar_path" "$(wc -c < "$tar_path" | tr -d ' ')"
}

printf 'Codex Speed %s\n' "$version"
build_package
printf '完成。\n'