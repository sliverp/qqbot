#!/bin/bash

# QQBot 拉取最新源码并更新
# 从 GitHub 拉取最新代码，安装依赖并重启网关
# 兼容 clawdbot / openclaw / moltbot，macOS 开箱即用
#
# 用法:
#   pull-latest.sh                          # 拉取最新代码并更新
#   pull-latest.sh --branch main            # 指定分支（默认 main）
#   pull-latest.sh --force                  # 跳过交互，强制更新
#   pull-latest.sh --repo <git-url>         # 指定仓库地址

set -euo pipefail

##############################################################################
# 常量 & 参数
##############################################################################
readonly DEFAULT_REPO="https://github.com/tencent-connect/openclaw-qq.git"
readonly GATEWAY_PORT=18789
readonly SUPPORTED_CLIS=(openclaw clawdbot moltbot)

FORCE=false
BRANCH="main"
REPO_URL=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -f|--force) FORCE=true; shift ;;
        -b|--branch) BRANCH="$2"; shift 2 ;;
        --repo) REPO_URL="$2"; shift 2 ;;
        -h|--help)
            echo "QQBot 拉取最新源码并更新"
            echo ""
            echo "用法:"
            echo "  pull-latest.sh                          # 拉取最新代码并更新"
            echo "  pull-latest.sh --branch main            # 指定分支（默认 main）"
            echo "  pull-latest.sh --force                  # 跳过交互，强制更新"
            echo "  pull-latest.sh --repo <git-url>         # 指定仓库地址"
            exit 0
            ;;
        *)
            echo "未知选项: $1 (使用 --help 查看帮助)"
            exit 1
            ;;
    esac
done
REPO_URL="${REPO_URL:-$DEFAULT_REPO}"

##############################################################################
# 工具函数
##############################################################################
json_get() {
    local file="$1" expr="$2"
    node -e "process.stdout.write(String((function(){$expr})(JSON.parse(require('fs').readFileSync('$file','utf8')))||''))" 2>/dev/null || true
}

##############################################################################
# 环境检查
##############################################################################
printf "%b\n" "\033[32m=========================================\033[0m"
printf "%b\n" "\033[32m  QQBot 拉取最新源码并更新\033[0m"
printf "%b\n" "\033[32m=========================================\033[0m"
echo ""

# 检查必要命令
for dep in node npm git; do
    if ! command -v "$dep" &>/dev/null; then
        printf "%b\n" "\033[31m❌ 未检测到 $dep，请先安装\033[0m"
        exit 1
    fi
done

printf "%b\n" "\033[34m系统信息:\033[0m"
echo "  macOS  $(sw_vers -productVersion 2>/dev/null || echo '未知')"
echo "  Node   $(node -v)"
echo "  npm    $(npm -v)"
echo "  Git    $(git --version 2>/dev/null | awk '{print $3}')"
echo "  仓库   $REPO_URL"
echo "  分支   $BRANCH"

# 检测 CLI
CMD=""
for name in "${SUPPORTED_CLIS[@]}"; do
    if command -v "$name" &>/dev/null; then
        CMD="$name"
        break
    fi
done
if [ -z "$CMD" ]; then
    printf "%b\n" "\033[31m❌ 未找到 openclaw / clawdbot / moltbot 命令，请先安装其中之一\033[0m"
    exit 1
fi
echo "  CLI    $CMD ($($CMD --version 2>/dev/null || echo '未知版本'))"

APP_HOME="$HOME/.$CMD"
APP_CONFIG="$APP_HOME/$CMD.json"

##############################################################################
# 定位插件目录
##############################################################################
PROJ_DIR=""
FRESH_INSTALL=false

for app in "${SUPPORTED_CLIS[@]}"; do
    ext_dir="$HOME/.$app/extensions/qqbot"
    if [ -d "$ext_dir" ] && [ -f "$ext_dir/package.json" ]; then
        PROJ_DIR="$ext_dir"
        break
    fi
done

if [ -z "$PROJ_DIR" ]; then
    PROJ_DIR="$APP_HOME/extensions/qqbot"
    FRESH_INSTALL=true
    echo "  插件   未安装（首次安装）"
else
    echo "  插件   $PROJ_DIR"
fi

##############################################################################
# 第一步：获取当前版本
##############################################################################
echo ""
printf "%b\n" "\033[34m1. 获取当前版本...\033[0m"

LOCAL_VER=""
LOCAL_COMMIT=""
if [ "$FRESH_INSTALL" = true ]; then
    echo "  首次安装，无本地版本"
else
    [ -f "$PROJ_DIR/package.json" ] && LOCAL_VER=$(json_get "$PROJ_DIR/package.json" "c => c.version")
    [ -d "$PROJ_DIR/.git" ] && LOCAL_COMMIT=$(cd "$PROJ_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "")
    echo "  当前版本: ${LOCAL_VER:-未知}${LOCAL_COMMIT:+ (${LOCAL_COMMIT})}"
fi

##############################################################################
# 第二步：备份通道配置
##############################################################################
echo ""
printf "%b\n" "\033[34m2. 备份通道配置...\033[0m"

SAVED_CHANNELS_JSON=""
for app in "${SUPPORTED_CLIS[@]}"; do
    cfg="$HOME/.$app/$app.json"
    [ -f "$cfg" ] || continue
    SAVED_CHANNELS_JSON=$(node -e "
        const cfg = JSON.parse(require('fs').readFileSync('$cfg', 'utf8'));
        const ch = cfg.channels && cfg.channels.qqbot;
        if (ch) process.stdout.write(JSON.stringify(ch));
    " 2>/dev/null || true)
    [ -n "$SAVED_CHANNELS_JSON" ] && break
done

if [ -n "$SAVED_CHANNELS_JSON" ]; then
    echo "  ✅ 已备份 qqbot 通道配置"
else
    echo "  ℹ️  未找到已有通道配置"
fi

##############################################################################
# 第三步：拉取最新代码
##############################################################################
echo ""
printf "%b\n" "\033[34m3. 拉取最新代码...\033[0m"

TMP_DIR="${TMPDIR:-/tmp}/qqbot-update-$$"
cleanup() { rm -rf "$TMP_DIR" 2>/dev/null; }
trap cleanup EXIT INT TERM

if [ -d "$PROJ_DIR/.git" ] && [ "$FRESH_INSTALL" = false ]; then
    cd "$PROJ_DIR"

    # 有本地修改直接重置，插件目录不需要保留用户改动
    if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
        echo "  检测到本地修改，自动重置..."
        git checkout -- . 2>/dev/null
        git clean -fd 2>/dev/null
    fi

    echo "  切换到分支 $BRANCH..."
    git fetch --all --prune 2>&1 | tail -3
    git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH" 2>/dev/null || true
    git reset --hard "origin/$BRANCH" 2>/dev/null

    REMOTE_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "")
    NEW_VER=$(json_get "$PROJ_DIR/package.json" "c => c.version")

    if [ -n "$LOCAL_COMMIT" ] && [ "$LOCAL_COMMIT" = "$REMOTE_COMMIT" ]; then
        echo "  ✅ 已是最新 ($LOCAL_VER, commit: $LOCAL_COMMIT)，继续检查依赖..."
    else
        echo "  更新: ${LOCAL_COMMIT:-???} → ${REMOTE_COMMIT}"
        git --no-pager log --oneline "${LOCAL_COMMIT}..HEAD" 2>/dev/null | head -10 || true
    fi
else
    rm -rf "$TMP_DIR"
    echo "  克隆仓库..."
    if ! git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$TMP_DIR" 2>&1 | tail -3; then
        printf "%b\n" "\033[31m❌ Git clone 失败\033[0m"
        echo ""
        echo "请排查:"
        echo "  1. 检查网络: curl -I https://github.com"
        echo "  2. 检查仓库地址: $REPO_URL"
        echo "  3. 如果是私有仓库，确认已配置 SSH key 或 token"
        exit 1
    fi

    mkdir -p "$PROJ_DIR"
    rsync -a --delete --exclude 'node_modules' "$TMP_DIR/" "$PROJ_DIR/"

    cd "$PROJ_DIR"
    REMOTE_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "")
    NEW_VER=$(json_get "$PROJ_DIR/package.json" "c => c.version")
    echo "  已克隆到版本: ${NEW_VER:-未知} (${REMOTE_COMMIT})"
    cleanup
fi

NEW_VER="${NEW_VER:-未知}"
printf "%b\n" "\033[32m  ✅ 代码已更新到 $NEW_VER\033[0m"

##############################################################################
# 第四步：安装依赖
##############################################################################
echo ""
printf "%b\n" "\033[34m4. 安装依赖...\033[0m"

cd "$PROJ_DIR"
if ! npm install --omit=dev 2>&1 | tail -5; then
    printf "%b\n" "\033[31m❌ npm 依赖安装失败\033[0m"
    echo ""
    echo "请排查:"
    echo "  1. 手动重试: cd $PROJ_DIR && npm install --omit=dev"
    echo "  2. 清理后重试: rm -rf $PROJ_DIR/node_modules && npm install --omit=dev"
    echo "  3. 切换镜像: npm config set registry https://registry.npmmirror.com/"
    exit 1
fi
echo "  ✅ 依赖安装完成"

##############################################################################
# 第五步：恢复配置 → 重启网关
##############################################################################
echo ""
printf "%b\n" "\033[34m5. 恢复配置并重启网关...\033[0m"

# 恢复通道配置
if [ -n "$SAVED_CHANNELS_JSON" ]; then
    if node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$APP_CONFIG', 'utf8'));
        cfg.channels = cfg.channels || {};
        cfg.channels.qqbot = $SAVED_CHANNELS_JSON;
        fs.writeFileSync('$APP_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
    " 2>/dev/null; then
        echo "  ✅ 通道配置已恢复"
    else
        printf "%b\n" "\033[33m  ⚠️  通道配置写入失败，请手动检查: $APP_CONFIG\033[0m"
    fi
elif [ "$FRESH_INSTALL" = true ]; then
    echo ""
    printf "%b\n" "\033[33m  ⚠️  首次安装，请配置 QQ Bot 凭据:\033[0m"
    echo "     $CMD channels add --channel qqbot --token 'YOUR_APPID:YOUR_SECRET'"
    echo ""
fi

# 停止旧 gateway
echo "  停止旧网关..."
$CMD gateway stop 2>/dev/null || true
sleep 1

# 强制杀占用端口的进程
PORT_PID=$(lsof -ti:"$GATEWAY_PORT" 2>/dev/null || true)
if [ -n "$PORT_PID" ]; then
    printf "%b\n" "\033[33m  ⚠️  端口 $GATEWAY_PORT 仍被占用 (PID: $PORT_PID)，强制终止...\033[0m"
    kill -9 $PORT_PID 2>/dev/null || true
    sleep 1
fi

# 卸载 launchd 服务（防止自动拉起旧进程）
for svc in ai.openclaw.gateway ai.clawdbot.gateway ai.moltbot.gateway; do
    launchctl bootout "gui/$(id -u)/$svc" 2>/dev/null || true
done

# 启动网关
echo "  启动网关..."
if $CMD gateway 2>&1; then
    printf "%b\n" "\033[32m  ✅ 网关已启动\033[0m"
else
    echo ""
    printf "%b\n" "\033[33m  ⚠️  网关启动失败（不影响已安装的插件）\033[0m"
    echo ""
    echo "  请手动启动:"
    echo "    1. 安装服务: $CMD gateway install"
    echo "    2. 启动网关: $CMD gateway"
    echo "    3. 查看日志: $CMD logs --follow"
fi

##############################################################################
# 完成
##############################################################################
echo ""
printf "%b\n" "\033[32m=========================================\033[0m"
printf "%b\n" "\033[32m  ✅ QQBot 已更新到 ${NEW_VER}${REMOTE_COMMIT:+ (${REMOTE_COMMIT})}\033[0m"
[ -n "$LOCAL_VER" ] && printf "%b\n" "\033[32m     (从 ${LOCAL_VER}${LOCAL_COMMIT:+ (${LOCAL_COMMIT})} 升级)\033[0m"
printf "%b\n" "\033[32m=========================================\033[0m"
echo ""
echo "常用命令:"
echo "  $CMD logs --follow        # 跟踪日志"
echo "  $CMD gateway restart      # 重启服务"
echo "  $CMD plugins list         # 查看插件列表"
echo "  cd $PROJ_DIR && git log   # 查看更新历史"
echo "========================================="
