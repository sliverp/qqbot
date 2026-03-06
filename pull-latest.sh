#!/bin/bash

# QQBot 拉取最新 npm 包并更新脚本
# 从 npm 下载 @sliverp/qqbot@latest，解压覆盖本地源码，重新安装插件并重启
# 兼容 clawdbot / openclaw / moltbot，macOS 开箱即用
# 脚本可放在任意位置运行，会自动定位已安装的插件目录
#
# 用法:
#   pull-latest.sh                          # 更新到最新版
#   pull-latest.sh @sliverp/qqbot@1.5.2    # 更新到指定版本
#   pull-latest.sh --force                  # 跳过交互，强制重新安装
#   pull-latest.sh --force @sliverp/qqbot@1.5.3

set -euo pipefail

# ============================================================
# 常量
# ============================================================
readonly PKG_NAME="@sliverp/qqbot"
readonly GATEWAY_PORT=18789
readonly SUPPORTED_CLIS=(openclaw clawdbot moltbot)

# ============================================================
# 参数解析
# ============================================================
FORCE=false
PKG_SPEC=""

for arg in "$@"; do
    case "$arg" in
        -f|--force) FORCE=true ;;
        -h|--help)
            echo "QQBot 拉取最新 npm 包并更新"
            echo ""
            echo "用法:"
            echo "  pull-latest.sh                          # 更新到最新版"
            echo "  pull-latest.sh @sliverp/qqbot@1.5.2    # 更新到指定版本"
            echo "  pull-latest.sh --force                  # 跳过交互，强制重新安装"
            echo "  pull-latest.sh --force @sliverp/qqbot@1.5.3"
            exit 0
            ;;
        *) PKG_SPEC="$arg" ;;
    esac
done
PKG_SPEC="${PKG_SPEC:-${PKG_NAME}@latest}"

# ============================================================
# 工具函数
# ============================================================
info()  { echo "ℹ️  $*"; }
ok()    { echo "✅ $*"; }
warn()  { echo "⚠️  $*"; }
fail()  { echo "❌ $*" >&2; exit 1; }

check_cmd() {
    command -v "$1" &>/dev/null || fail "缺少必要命令: $1 — $2"
}

# 从 JSON 文件提取值（避免依赖 jq）
json_get() {
    local file="$1" expr="$2"
    node -e "process.stdout.write(String((function(){$expr})(JSON.parse(require('fs').readFileSync('$file','utf8')))||''))" 2>/dev/null || true
}

# ============================================================
# 前置检查
# ============================================================
check_cmd node "请安装 Node.js: https://nodejs.org/"
check_cmd npm  "npm 通常随 Node.js 一起安装"
check_cmd tar  "macOS 自带 tar，如果缺失请检查系统完整性"

echo "========================================="
echo "  QQBot 拉取最新版本并更新"
echo "========================================="
echo ""
echo "系统信息:"
echo "  macOS $(sw_vers -productVersion 2>/dev/null || echo '未知')"
echo "  Node  $(node -v)"
echo "  npm   $(npm -v)"

# ============================================================
# 检测 CLI 命令
# ============================================================
CMD=""
for name in "${SUPPORTED_CLIS[@]}"; do
    if command -v "$name" &>/dev/null; then
        CMD="$name"
        break
    fi
done
[ -z "$CMD" ] && fail "未找到 openclaw / clawdbot / moltbot 命令，请先安装其中之一"
echo "  CLI   $CMD ($($CMD --version 2>/dev/null || echo '未知版本'))"

# 推导配置目录
APP_HOME="$HOME/.$CMD"
APP_CONFIG="$APP_HOME/$CMD.json"

# ============================================================
# 定位插件目录（自动搜索，不依赖脚本自身位置）
# ============================================================
PROJ_DIR=""
FRESH_INSTALL=false

# 从 extensions 目录查找已安装的插件
for app in "${SUPPORTED_CLIS[@]}"; do
    ext_dir="$HOME/.$app/extensions/qqbot"
    if [ -d "$ext_dir" ] && [ -f "$ext_dir/package.json" ]; then
        pkg_name=$(json_get "$ext_dir/package.json" "c => c.name")
        if [ "$pkg_name" = "$PKG_NAME" ]; then
            PROJ_DIR="$ext_dir"
            break
        fi
    fi
done

# 未找到已安装插件 → 首次安装模式，使用当前 CLI 的 extensions 目录
if [ -z "$PROJ_DIR" ]; then
    PROJ_DIR="$APP_HOME/extensions/qqbot"
    FRESH_INSTALL=true
    mkdir -p "$PROJ_DIR"
    info "未找到已安装插件，将作为首次安装: $PROJ_DIR"
else
    echo "  插件目录: $PROJ_DIR"
fi
cd "$PROJ_DIR"

# ============================================================
# [1/5] 获取当前本地版本
# ============================================================
echo ""
LOCAL_VER=""
if [ "$FRESH_INSTALL" = true ]; then
    info "[1/5] 首次安装，无本地版本"
else
    [ -f "$PROJ_DIR/package.json" ] && LOCAL_VER=$(json_get "$PROJ_DIR/package.json" "c => c.version")
    info "[1/5] 当前本地版本: ${LOCAL_VER:-未知}"
fi

# ============================================================
# [2/5] 查询目标版本
# ============================================================
echo ""
info "[2/5] 查询 npm 版本..."

if echo "$PKG_SPEC" | grep -qE '@[0-9]+\.[0-9]+'; then
    REMOTE_VER=$(echo "$PKG_SPEC" | sed 's/.*@//')
else
    REMOTE_VER=$(npm view "$PKG_NAME" version 2>/dev/null || echo "")
fi

if [ -z "$REMOTE_VER" ]; then
    echo ""
    echo "❌ 无法查询 $PKG_NAME 的版本"
    echo ""
    echo "当前 npm 源: $(npm config get registry 2>/dev/null || echo '未知')"
    echo ""
    echo "请排查:"
    echo "  1. 检查网络连接: curl -I https://registry.npmjs.org/"
    echo "  2. 切换国内镜像: npm config set registry https://registry.npmmirror.com/"
    echo "  3. 确认包名正确: npm view $PKG_NAME version"
    exit 1
fi
echo "  目标版本: ${REMOTE_VER}"

# 版本相同时判断是否需要继续
if [ "$LOCAL_VER" = "$REMOTE_VER" ]; then
    ok "本地版本已是最新 ($LOCAL_VER)"
    if [ "$FORCE" != true ]; then
        printf "是否强制重新安装? (y/N): "
        read -r force_choice </dev/tty 2>/dev/null || force_choice="N"
        case "$force_choice" in
            [Yy]* ) info "强制重新安装..." ;;
            * ) echo "跳过更新。"; exit 0 ;;
        esac
    else
        info "--force 已指定，继续重新安装..."
    fi
fi

# ============================================================
# [3/5] 备份通道配置
# ============================================================
echo ""
info "[3/5] 备份已有通道配置..."

SAVED_CHANNELS_JSON=""

# 从配置文件中完整备份 channels.qqbot 对象
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
    echo "  已备份 qqbot 通道配置"
else
    echo "  未找到已有通道配置（首次安装或已清理）"
fi

# ============================================================
# [4/5] 下载、解压、同步文件
# ============================================================
echo ""
info "[4/5] 下载 $PKG_SPEC 并更新本地文件..."

TMP_DIR="${TMPDIR:-/tmp}/qqbot-update-$$"

cleanup() { rm -rf "$TMP_DIR" "${TMPDIR:-/tmp}/qqbot-stage-$$" 2>/dev/null; }
trap cleanup EXIT INT TERM

rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

echo "  下载中..."
TARBALL=$(cd "$TMP_DIR" && npm pack "$PKG_SPEC" 2>&1) || true
if [ -z "$TARBALL" ] || [ ! -f "$TMP_DIR/$TARBALL" ]; then
    echo ""
    echo "❌ 下载 npm 包失败: $PKG_SPEC"
    echo ""
    echo "npm pack 输出: ${TARBALL:-无}"
    echo ""
    echo "请排查:"
    echo "  1. 检查网络: curl -I https://registry.npmjs.org/"
    echo "  2. 手动测试: npm pack $PKG_SPEC"
    echo "  3. 切换镜像: npm config set registry https://registry.npmmirror.com/"
    echo "  4. 清理缓存: npm cache clean --force"
    exit 1
fi

echo "  解压中..."
if ! tar xzf "$TMP_DIR/$TARBALL" -C "$TMP_DIR"; then
    echo ""
    echo "❌ 解压 npm 包失败"
    echo ""
    echo "文件: $TMP_DIR/$TARBALL"
    echo "文件大小: $(ls -lh "$TMP_DIR/$TARBALL" 2>/dev/null | awk '{print $5}' || echo '未知')"
    echo ""
    echo "请排查:"
    echo "  1. 下载可能不完整，重新运行此脚本"
    echo "  2. 手动解压测试: tar xzf $TMP_DIR/$TARBALL"
    exit 1
fi

PACK_DIR="$TMP_DIR/package"
if [ ! -d "$PACK_DIR" ]; then
    echo ""
    echo "❌ 解压后未找到 package 目录"
    echo ""
    echo "解压内容: $(ls "$TMP_DIR" 2>/dev/null)"
    echo ""
    echo "npm 包格式可能不正确，请联系包维护者"
    exit 1
fi

NEW_VER=$(json_get "$PACK_DIR/package.json" "c => c.version")
NEW_VER="${NEW_VER:-$REMOTE_VER}"
echo "  将更新到版本: $NEW_VER"

# 同步文件（跳过 .DS_Store / .git / node_modules）
echo "  同步文件..."
(
    cd "$PACK_DIR"
    find . -type f \
        ! -name '.DS_Store' \
        ! -path './.git/*' \
        ! -path './node_modules/*' \
    | while IFS= read -r f; do
        mkdir -p "$PROJ_DIR/$(dirname "$f")"
        cp -f "$f" "$PROJ_DIR/$f"
    done
)

ok "文件已更新到 $NEW_VER"

# 立即清理临时文件
cleanup

echo "  安装依赖..."
cd "$PROJ_DIR"
if ! npm install --omit=dev 2>&1 | tail -5; then
    echo ""
    echo "❌ npm 依赖安装失败"
    echo ""
    echo "请排查:"
    echo "  1. 手动重试: cd $PROJ_DIR && npm install --omit=dev"
    echo "  2. 查看详细日志: cd $PROJ_DIR && npm install --omit=dev --verbose"
    echo "  3. 清理后重试: rm -rf $PROJ_DIR/node_modules && npm install --omit=dev"
    echo "  4. 切换镜像: npm config set registry https://registry.npmmirror.com/"
    exit 1
fi

# ============================================================
# [5/5] 卸载旧插件 → 临时移除 channel 配置 → 安装新插件 → 恢复配置 → 重启
# ============================================================
echo ""
info "[5/5] 重新安装插件并重启..."

# --- 5a. 将更新后的文件移到临时位置，清理旧扩展，再移回来安装 ---
STAGE_DIR="${TMPDIR:-/tmp}/qqbot-stage-$$"
rm -rf "$STAGE_DIR"
cp -a "$PROJ_DIR" "$STAGE_DIR"

for app in "${SUPPORTED_CLIS[@]}"; do
    ext_dir="$HOME/.$app/extensions/qqbot"
    if [ -d "$ext_dir" ]; then
        echo "  删除旧扩展: $ext_dir"
        rm -rf "$ext_dir"
    fi
done

# 移回安装位置
mkdir -p "$(dirname "$PROJ_DIR")"
mv "$STAGE_DIR" "$PROJ_DIR"

# --- 5b. 临时移除 qqbot 相关配置（避免 openclaw 校验失败） ---
NEED_RESTORE_CHANNELS=false
if [ -f "$APP_CONFIG" ]; then
    echo "  临时移除 qqbot 相关配置（安装后恢复）..."
    node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$APP_CONFIG', 'utf8'));
        let changed = false;
        if (cfg.channels && cfg.channels.qqbot) { delete cfg.channels.qqbot; changed = true; }
        if (cfg.plugins && cfg.plugins.entries && cfg.plugins.entries.qqbot) { delete cfg.plugins.entries.qqbot; changed = true; }
        if (cfg.plugins && cfg.plugins.installs && cfg.plugins.installs.qqbot) { delete cfg.plugins.installs.qqbot; changed = true; }
        if (changed) fs.writeFileSync('$APP_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
        process.stdout.write(changed ? 'yes' : 'no');
    " 2>/dev/null && NEED_RESTORE_CHANNELS=true
fi

# --- 5c. 安装插件 ---
echo ""
echo "  安装新版本插件..."
cd "$PROJ_DIR"
if ! $CMD plugins install "$PROJ_DIR" 2>&1; then
    # 安装失败时尝试恢复配置
    if [ "$NEED_RESTORE_CHANNELS" = true ] && [ -n "$SAVED_CHANNELS_JSON" ]; then
        node -e "
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$APP_CONFIG', 'utf8'));
            cfg.channels = cfg.channels || {};
            cfg.channels.qqbot = $SAVED_CHANNELS_JSON;
            fs.writeFileSync('$APP_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
        " 2>/dev/null && echo "  (已恢复通道配置)"
    fi
    echo ""
    echo "❌ 插件安装失败"
    echo ""
    echo "请排查:"
    echo "  1. 检查上方的错误输出"
    echo "  2. 手动重试: cd $PROJ_DIR && $CMD plugins install ."
    echo "  3. 检查插件目录是否完整: ls -la $PROJ_DIR/"
    echo "  4. 检查 package.json 是否存在: cat $PROJ_DIR/package.json"
    echo "  5. 确认 $CMD 版本兼容: $CMD --version"
    exit 1
fi
ok "插件安装成功"

# --- 5d. 恢复 channels.qqbot 配置 ---
if [ -n "$SAVED_CHANNELS_JSON" ]; then
    echo "  恢复 qqbot 通道配置..."
    if node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$APP_CONFIG', 'utf8'));
        cfg.channels = cfg.channels || {};
        cfg.channels.qqbot = $SAVED_CHANNELS_JSON;
        fs.writeFileSync('$APP_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
    " 2>/dev/null; then
        ok "通道配置已恢复"
    else
        echo ""
        echo "⚠️  通道配置恢复失败"
        echo ""
        echo "请手动恢复:"
        echo "  $CMD channels add --channel qqbot --token 'YOUR_APPID:YOUR_SECRET'"
        echo ""
        echo "或直接编辑配置文件: $APP_CONFIG"
    fi
fi

# --- 5e. 停止旧 gateway ---
echo ""
echo "  停止旧网关..."
$CMD gateway stop 2>/dev/null || true
sleep 1

# 强制杀占用端口的进程
PORT_PID=$(lsof -ti:"$GATEWAY_PORT" 2>/dev/null || true)
if [ -n "$PORT_PID" ]; then
    warn "端口 $GATEWAY_PORT 仍被占用 (PID: $PORT_PID)，强制终止..."
    kill -9 $PORT_PID 2>/dev/null || true
    sleep 1
fi

# 卸载 launchd 服务（防止自动拉起旧进程）
for svc in ai.openclaw.gateway ai.clawdbot.gateway ai.moltbot.gateway; do
    launchctl bootout "gui/$(id -u)/$svc" 2>/dev/null || true
done

# --- 5f. 启动新 gateway ---
echo "  启动网关..."
if $CMD gateway 2>&1; then
    ok "网关已启动"
else
    echo ""
    echo "⚠️  网关启动失败（不影响已安装的插件）"
    echo ""
    echo "请手动启动:"
    echo "  1. 安装服务: $CMD gateway install"
    echo "  2. 启动网关: $CMD gateway"
    echo "  3. 查看日志: $CMD logs --follow"
fi

# ============================================================
# 完成
# ============================================================
echo ""
echo "========================================="
echo "  ✅ QQBot 已从 ${LOCAL_VER:-未知} 更新到 ${NEW_VER}"
echo "========================================="
echo ""
echo "常用命令:"
echo "  $CMD logs --follow        # 跟踪日志"
echo "  $CMD gateway restart      # 重启服务"
echo "  $CMD plugins list         # 查看插件列表"
echo "========================================="
