#!/usr/bin/env bash
# 一键安装本地定时任务（macOS launchd）。在项目根目录运行：
#   bash scripts/install-cron.sh
# 安全渲染 plist 到暂存目录，全部验证后再原子替换并加载。
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" || "$NODE_BIN" != /* || ! -x "$NODE_BIN" ]]; then
  echo "找不到绝对路径 Node 可执行文件；请先安装 Node 20.19–25。" >&2
  exit 1
fi
NPM_BIN="$(command -v npm || true)"
PLUTIL_BIN="$(command -v plutil || true)"
LAUNCHCTL_BIN="$(command -v launchctl || true)"
for tool in "$NPM_BIN" "$PLUTIL_BIN" "$LAUNCHCTL_BIN"; do
  if [[ -z "$tool" || "$tool" != /* || ! -x "$tool" ]]; then
    echo "安装需要绝对路径且可执行的 npm、plutil 与 launchctl。" >&2
    exit 1
  fi
done

# Refuse to install a job that is guaranteed to fail or reads an unsafe env file.
(cd "$DIR" && "$NPM_BIN" run preflight -- --target ingest:send)
(cd "$DIR" && "$NPM_BIN" run doctor)

# macOS TCC 坑：~/Desktop|Documents|Downloads 下的文件 LaunchAgent 读不到 → 任务必失败。
case "$DIR" in
  "$HOME/Desktop"|"$HOME/Desktop/"*|"$HOME/Documents"|"$HOME/Documents/"*|"$HOME/Downloads"|"$HOME/Downloads/"*)
    echo "⚠️  项目在受 macOS 隐私保护（TCC）的目录下，launchd 会读不到文件、任务必失败。"
    echo "    请把项目移到非保护目录（如 ~/frontier-paper-dispatch）后再装。"
    exit 1 ;;
esac

JOBS=(deliver ingest refine)
AGENTS_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS_DIR"
STAGE_DIR="$(mktemp -d "$AGENTS_DIR/.frontierpapers.install.XXXXXX")"
cleanup() {
  [[ -n "${STAGE_DIR:-}" && -d "$STAGE_DIR" ]] && rm -rf -- "$STAGE_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

restore_plists() {
  local job dst
  for job in "${JOBS[@]}"; do
    dst="$AGENTS_DIR/com.frontierpapers.$job.plist"
    if [[ -f "$STAGE_DIR/had.$job" ]]; then
      mv -f "$STAGE_DIR/backup.$job.plist" "$dst"
    else
      rm -f -- "$dst"
    fi
  done
}

# Render and validate every job before replacing either installed plist.
for job in "${JOBS[@]}"; do
  src="$DIR/launchd/com.frontierpapers.$job.plist"
  staged="$STAGE_DIR/new.$job.plist"
  # Read the renderer through stdin because Node's ESM entrypoint resolver rejects otherwise valid
  # macOS paths containing a literal backslash.
  "$NODE_BIN" --input-type=module - "$src" "$staged" "$DIR" "$NODE_BIN" < "$DIR/scripts/render-launchd-plist.mjs"
  "$PLUTIL_BIN" -lint "$staged" >/dev/null
done

for job in "${JOBS[@]}"; do
  dst="$AGENTS_DIR/com.frontierpapers.$job.plist"
  if [[ -f "$dst" ]]; then
    cp -p "$dst" "$STAGE_DIR/backup.$job.plist"
    : > "$STAGE_DIR/had.$job"
  fi
done

for job in "${JOBS[@]}"; do
  dst="$AGENTS_DIR/com.frontierpapers.$job.plist"
  if ! mv -f "$STAGE_DIR/new.$job.plist" "$dst"; then
    restore_plists
    echo "替换 LaunchAgent plist 失败，已恢复原文件。" >&2
    exit 1
  fi
done

for job in "${JOBS[@]}"; do
  dst="$AGENTS_DIR/com.frontierpapers.$job.plist"
  "$LAUNCHCTL_BIN" unload "$dst" 2>/dev/null || true
  if ! "$LAUNCHCTL_BIN" load "$dst"; then
    echo "launchd 拒绝 com.frontierpapers.${job}，正在回滚全部任务。" >&2
    for rollback_job in "${JOBS[@]}"; do
      "$LAUNCHCTL_BIN" unload "$AGENTS_DIR/com.frontierpapers.$rollback_job.plist" 2>/dev/null || true
    done
    restore_plists
    for rollback_job in "${JOBS[@]}"; do
      if [[ -f "$STAGE_DIR/had.$rollback_job" ]]; then
        "$LAUNCHCTL_BIN" load "$AGENTS_DIR/com.frontierpapers.$rollback_job.plist" 2>/dev/null || true
      fi
    done
    exit 1
  fi
  echo "✓ 已安装 com.frontierpapers.$job"
done

echo
echo "立即测一次（不用等计划时间）："
echo "  launchctl start com.frontierpapers.refine && sleep 5 && tail -5 refine.log"
echo "卸载：launchctl unload ~/Library/LaunchAgents/com.frontierpapers.{deliver,ingest,refine}.plist"
