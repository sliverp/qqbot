#!/bin/bash

# QQBot 拉取最新 npm 包并更新脚本
# 从 npm 下载 @tencent-connect/openclaw-qq@latest，解压覆盖本地源码，重新安装插件并重启
# 兼容 clawdbot / openclaw / moltbot，macOS 开箱即用
#
# 用法:
#   ./scripts/pull-latest.sh                  # 更新到最新版
#   ./scripts/pull-latest.sh @tencent-connect/openclaw-qq@1.5.2   # 更新到指定版本
#   ./scripts/pull-latest.sh --force          # 跳过交互，强制重新安装
#   ./scripts/pull-latest.sh --force @tencent-connect/openclaw-qq@1.5.3

set -e

# ============================================================
# 参数解析
# ============================================================
FORCE=false
PKG_NAME="@tencent-connect/openclaw-qq"
PKG_SPEC=""

for arg in "$@"; do
    case "$arg" in
        -f|--force) FORCE=true ;;
        *)          PKG_SPEC="$arg" ;;
    esac
done
PKG_SPEC="${PKG_SPEC:-${PKG_NAME}@latest}"

# ============================================================
# 定位项目目录（兼容从任意位置执行）
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 如果脚本在 scripts/ 子目录里，往上一级就是项目根目录
if [ "$(basename "$SCRIPT_DIR")" = "scripts" ]; then
    PROJ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    PROJ_DIR="$SCRIPT_DIR"
fi
cd "$PROJ_DIR"

# ============================================================
# 前置依赖检查
# ============================================================
check_cmd() {
    if ! command -v "$1" &>/dev/null; then
        echo "❌ 缺少必要命令: $1"
        echo "   $2"
        exit 1
    fi
}

check_cmd node  "请先安装 Node.js: https://nodejs.org/ 或 brew install node"
check_cmd npm   "npm 通常随 Node.js 一起安装"
check_cmd tar   "macOS 自带 tar，如果缺失请检查系统完整性"

echo "========================================="
echo "  QQBot 拉取最新版本并更新"
echo "========================================="
echo ""
echo "系统信息:"
echo "  macOS $(sw_vers -productVersion 2>/dev/null || echo '未知')"
echo "  Node  $(node -v 2>/dev/null)"
echo "  npm   $(npm -v 2>/dev/null)"

# ============================================================
# 0. 检测 openclaw / clawdbot / moltbot
# ============================================================
CMD=""
for name in openclaw clawdbot moltbot; do
    if command -v "$name" &>/dev/null; then
        CMD="$name"
        break
    fi
done
if [ -z "$CMD" ]; then
    echo ""
    echo "❌ 未找到 openclaw / clawdbot / moltbot 命令"
    echo "   请先安装其中之一，参考: https://docs.openclaw.ai"
    exit 1
fi
echo "  CLI   $CMD ($($CMD --version 2>/dev/null || echo '未知版本'))"

# ============================================================
# 1. 获取当前本地版本
# ============================================================
LOCAL_VER=""
if [ -f "$PROJ_DIR/package.json" ]; then
    LOCAL_VER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$PROJ_DIR/package.json','utf8')).version||'')" 2>/dev/null || true)
fi
echo ""
echo "[1/5] 当前本地版本: ${LOCAL_VER:-未知}"

# ============================================================
# 2. 查询 npm 远程版本
# ============================================================
echo ""
echo "[2/5] 查询 npm 版本..."

# 如果指定了具体版本号，直接从 PKG_SPEC 提取；否则查询 latest
if echo "$PKG_SPEC" | grep -qE '@[0-9]+\.[0-9]+'; then
    REMOTE_VER=$(echo "$PKG_SPEC" | sed 's/.*@//')
else
    REMOTE_VER=$(npm view "$PKG_NAME" version 2>/dev/null || echo "")
fi

if [ -z "$REMOTE_VER" ]; then
    echo "❌ 无法查询 $PKG_NAME 的版本，请检查网络"
    echo "   当前 npm 源: $(npm config get registry 2>/dev/null)"
    echo ""
    echo "   可尝试切换镜像源:"
    echo "   npm config set registry https://registry.npmmirror.com/"
    exit 1
fi
echo "目标版本: ${REMOTE_VER}"

if [ "$LOCAL_VER" = "$REMOTE_VER" ]; then
    echo ""
    echo "✅ 本地版本已是最新 ($LOCAL_VER)"
    if [ "$FORCE" = true ]; then
        echo "已指定 --force，继续重新安装..."
    else
        printf "是否强制重新安装? (y/N): "
        read -r force_choice </dev/tty 2>/dev/null || force_choice="N"
        case "$force_choice" in
            [Yy]* ) echo "强制重新安装..." ;;
            * ) echo "跳过更新。"; exit 0 ;;
        esac
    fi
fi

# ============================================================
# 3. 备份通道配置
# ============================================================
echo ""
echo "[3/5] 备份已有通道配置..."

SAVED_QQBOT_TOKEN=""
SAVED_MARKDOWN=""

for APP_NAME in openclaw clawdbot moltbot; do
    CONFIG_FILE="$HOME/.$APP_NAME/$APP_NAME.json"
    [ -f "$CONFIG_FILE" ] || continue

    if [ -z "$SAVED_QQBOT_TOKEN" ]; then
        SAVED_QQBOT_TOKEN=$(node -e "
            const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
            const ch = cfg.channels && cfg.channels.qqbot;
            if (!ch) process.exit(0);
            if (ch.token) { process.stdout.write(ch.token); process.exit(0); }
            if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId + ':' + ch.clientSecret); process.exit(0); }
        " 2>/dev/null || true)
    fi

    if [ -z "$SAVED_MARKDOWN" ]; then
        SAVED_MARKDOWN=$(node -e "
            const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
            const v = (cfg.channels && cfg.channels.qqbot && cfg.channels.qqbot.markdownSupport);
            if (v !== undefined && v !== null) process.stdout.write(String(v));
        " 2>/dev/null || true)
    fi

    [ -n "$SAVED_QQBOT_TOKEN" ] && [ -n "$SAVED_MARKDOWN" ] && break
done

if [ -n "$SAVED_QQBOT_TOKEN" ]; then
    echo "已备份 qqbot 通道 token: ${SAVED_QQBOT_TOKEN:0:10}..."
else
    echo "未找到已有通道配置（首次安装或已清理）"
fi

# ============================================================
# 4. 下载并解压最新包
# ============================================================
echo ""
echo "[4/5] 下载 $PKG_SPEC 并更新本地文件..."

TMP_DIR="$PROJ_DIR/.qqbot-update-tmp"

# 清理函数：删除临时文件夹
cleanup() {
    if [ -d "$TMP_DIR" ]; then
        echo "清理临时文件夹: $TMP_DIR"
        rm -rf "$TMP_DIR"
    fi
}
# 正常退出、中断、终止时都清理
trap cleanup EXIT INT TERM

# 如果上次意外残留，先清理
[ -d "$TMP_DIR" ] && rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

echo "下载中..."
TARBALL=$(cd "$TMP_DIR" && npm pack "$PKG_SPEC" 2>/dev/null)
if [ -z "$TARBALL" ] || [ ! -f "$TMP_DIR/$TARBALL" ]; then
    echo "❌ 下载失败"
    echo "   请检查网络连接，或尝试:"
    echo "   npm pack $PKG_SPEC"
    exit 1
fi
echo "已下载: $TARBALL"

echo "解压中..."
tar xzf "$TMP_DIR/$TARBALL" -C "$TMP_DIR"

PACK_DIR="$TMP_DIR/package"
if [ ! -d "$PACK_DIR" ]; then
    echo "❌ 解压后未找到 package 目录"
    exit 1
fi

NEW_VER=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$PACK_DIR/package.json','utf8')).version||'')" 2>/dev/null || echo "$REMOTE_VER")
echo "将更新到版本: $NEW_VER"

# 同步文件（不用 rsync，用 tar + cp 保证 macOS 原生兼容）
echo "同步文件到本地..."

# 把包中所有文件复制过来，跳过不该覆盖的目录
(
    cd "$PACK_DIR"
    find . -type f | while IFS= read -r f; do
        case "$f" in
            ./.DS_Store|./.git/*|./node_modules/*) continue ;;
        esac
        dir=$(dirname "$f")
        mkdir -p "$PROJ_DIR/$dir"
        cp -f "$f" "$PROJ_DIR/$f"
    done
)

echo "✅ 文件已更新到 $NEW_VER"

# 删除临时文件夹（不等到 EXIT，立即清理）
echo "删除临时文件夹..."
rm -rf "$TMP_DIR"

echo "安装依赖..."
cd "$PROJ_DIR"
npm install --omit=dev 2>&1 | tail -5

# ============================================================
# 5. 卸载旧插件、安装新插件、恢复配置、重启
# ============================================================
echo ""
echo "[5/5] 重新安装插件并重启..."

# 清理旧版本（配置 + 扩展目录）
if [ -f "$PROJ_DIR/scripts/upgrade.sh" ]; then
    echo "清理旧版本插件..."
    bash "$PROJ_DIR/scripts/upgrade.sh"
fi

# 强制删除已有扩展目录，防止 "plugin already exists" 错误
for APP_NAME in openclaw clawdbot moltbot; do
    EXT_DIR="$HOME/.$APP_NAME/extensions/qqbot"
    if [ -d "$EXT_DIR" ]; then
        echo "删除已有扩展目录: $EXT_DIR"
        rm -rf "$EXT_DIR"
    fi
done

# 安装插件
echo ""
echo "安装新版本插件..."
if ! $CMD plugins install . 2>&1; then
    echo "❌ 插件安装失败，请检查上方错误信息"
    exit 1
fi
echo "✅ 插件安装成功"

# 恢复通道配置
if [ -n "$SAVED_QQBOT_TOKEN" ]; then
    echo ""
    echo "恢复 qqbot 通道配置..."
    $CMD channels add --channel qqbot --token "$SAVED_QQBOT_TOKEN" 2>&1 || true
fi

# 恢复 markdown 配置
if [ "$SAVED_MARKDOWN" = "true" ]; then
    echo "恢复 Markdown 配置 (已启用)..."
    APP_CONFIG="$HOME/.$CMD/$CMD.json"
    if [ -f "$APP_CONFIG" ]; then
        node -e "
          var fs = require('fs');
          var cfg = JSON.parse(fs.readFileSync('$APP_CONFIG', 'utf-8'));
          if (!cfg.channels) cfg.channels = {};
          if (!cfg.channels.qqbot) cfg.channels.qqbot = {};
          cfg.channels.qqbot.markdownSupport = true;
          fs.writeFileSync('$APP_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
        " 2>/dev/null && echo "✅ Markdown 配置已恢复" || echo "⚠️  Markdown 配置恢复失败"
    fi
fi

# 重启网关（先确保旧进程停掉，避免无限重启循环）
echo ""
echo "重启网关服务..."

# 先尝试正常停止
$CMD gateway stop 2>/dev/null || true
sleep 1

# 如果端口还被占用，强制杀进程
PORT_PID=$(lsof -ti:18789 2>/dev/null || true)
if [ -n "$PORT_PID" ]; then
    echo "端口 18789 仍被占用 (pid: $PORT_PID)，强制终止..."
    kill -9 $PORT_PID 2>/dev/null || true
    sleep 1
fi

# 卸载 launchd 服务（防止自动拉起旧进程）
for SVC_NAME in ai.openclaw.gateway ai.clawdbot.gateway ai.moltbot.gateway; do
    launchctl bootout "gui/$(id -u)/$SVC_NAME" 2>/dev/null || true
done

# 启动新的 gateway
if $CMD gateway 2>&1; then
    echo ""
    echo "✅ 网关已启动"
    echo "查看日志: $CMD gateway log"
else
    echo ""
    echo "⚠️  网关启动失败，尝试手动启动:"
    echo "  $CMD gateway install && $CMD gateway"
fi

echo ""
echo "========================================="
echo "  ✅ QQBot 已从 ${LOCAL_VER:-未知} 更新到 ${NEW_VER}"
echo "========================================="
echo ""
echo "常用命令:"
echo "  $CMD gateway log          # 查看日志"
echo "  $CMD gateway restart      # 重启服务"
echo "  $CMD plugins list         # 查看插件列表"
echo "========================================="
