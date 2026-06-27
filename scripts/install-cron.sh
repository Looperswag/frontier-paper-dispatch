#!/usr/bin/env bash
# 一键安装本地定时任务（macOS launchd）。在项目根目录运行：
#   bash scripts/install-cron.sh
# 自动用当前项目绝对路径填充 plist 模板里的 __PROJECT_DIR__，装到 ~/Library/LaunchAgents 并加载。
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"

# macOS TCC 坑：~/Desktop|Documents|Downloads 下的文件 LaunchAgent 读不到 → 任务必失败。
case "$DIR" in
  "$HOME/Desktop/"*|"$HOME/Documents/"*|"$HOME/Downloads/"*)
    echo "⚠️  项目在受 macOS 隐私保护（TCC）的目录下，launchd 会读不到文件、任务必失败。"
    echo "    请把项目移到非保护目录（如 ~/frontier-paper-dispatch）后再装。"
    exit 1 ;;
esac

mkdir -p "$HOME/Library/LaunchAgents"
for job in ingest refine; do
  src="$DIR/launchd/com.frontierpapers.$job.plist"
  dst="$HOME/Library/LaunchAgents/com.frontierpapers.$job.plist"
  sed "s|__PROJECT_DIR__|$DIR|g" "$src" > "$dst"
  launchctl unload "$dst" 2>/dev/null || true
  launchctl load "$dst"
  echo "✓ 已安装 com.frontierpapers.$job"
done

echo
echo "立即测一次（不用等计划时间）："
echo "  launchctl start com.frontierpapers.refine && sleep 5 && tail -5 refine.log"
echo "卸载：launchctl unload ~/Library/LaunchAgents/com.frontierpapers.{ingest,refine}.plist"
