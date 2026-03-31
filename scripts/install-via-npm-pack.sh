#!/bin/bash

# qqbot 通过 npm pack 直接安装（独立验证脚本）
#
# 参考飞书（npx @larksuite/openclaw-lark-tools update）、微信、企微的做法，
# 通过 npm pack + 手动部署 安装插件，绕过 openclaw CLI 的 plugins install/update 逻辑。
#
# 流程：
#   1. npm pack <pkg> 下载 tgz（多 registry 兜底）
#   2. tar xzf 解压到临时目录
#   3. 检查 bundled dependencies，缺失则 npm install --omit=dev
#   4. 备份旧目录 → 部署到 extensions 目录
#   5. 手动写入 plugins.installs / plugins.entries / plugins.allow 配置
#   6. 执行 postinstall-link-sdk.js 创建 SDK symlink
#   7. 验证安装完整性
#
# 用法:
#   install-via-npm-pack.sh                                    # 安装 latest
#   install-via-npm-pack.sh --version <version>                # 安装指定版本
#   install-via-npm-pack.sh --pkg <scope/name>                 # 指定 npm 包名
#   install-via-npm-pack.sh --timeout 600                      # 自定义超时（秒，默认300）
#   install-via-npm-pack.sh --dry-run                          # 只下载解压，不部署（验证用）

set -eo pipefail

# ============================================================================
#  进程隔离 — 脱离 gateway 进程组
# ============================================================================
# 当脚本由 openclaw gateway 子进程 fork 执行时，属于 gateway 的进程组。
# gateway restart 发送 SIGTERM 会连带杀死本脚本。
# 用 setsid 创建新的会话和进程组，使本脚本不受 gateway 信号影响。
if [ -z "$_UPGRADE_ISOLATED" ] && command -v setsid &>/dev/null; then
    export _UPGRADE_ISOLATED=1
    exec setsid "$0" "$@"
fi

# ============================================================================
#  环境准备
# ============================================================================

# 解析脚本路径
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || SCRIPT_DIR=""
PROJECT_DIR=""
[ -n "$SCRIPT_DIR" ] && PROJECT_DIR="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)" || true

# 确保 CWD 有效
cd "$HOME" 2>/dev/null || cd / 2>/dev/null || true

ensure_valid_cwd() {
    if ! stat . &>/dev/null 2>&1; then
        cd "$HOME" 2>/dev/null || cd / 2>/dev/null || true
    fi
}

# 读取 package.json 中的 version 字段
# 用法: read_pkg_version <package.json 路径>
read_pkg_version() {
    node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('$1','utf8')).version||'')}catch{}" 2>/dev/null || true
}

# 修复 PATH
for _extra_path in /usr/local/bin /usr/local/sbin /usr/bin /usr/sbin /bin /sbin; do
    case ":$PATH:" in
        *":$_extra_path:"*) ;;
        *) [ -d "$_extra_path" ] && export PATH="$PATH:$_extra_path" ;;
    esac
done

# 确保 npm registry 可用
if [ -z "$npm_config_registry" ]; then
    export npm_config_registry="https://registry.npmjs.org"
fi

# ============================================================================
#  超时执行包装器
# ============================================================================
run_with_timeout() {
    local timeout_secs="$1"
    local description="$2"
    shift 2

    if command -v timeout &>/dev/null; then
        echo "  [超时保护] ${description}: 最长等待 ${timeout_secs}s"
        if timeout --kill-after=10 "$timeout_secs" "$@"; then
            return 0
        else
            local rc=$?
            if [ $rc -eq 124 ]; then
                echo "  ⏰ [超时] ${description} 超过 ${timeout_secs}s，已终止"
            fi
            return $rc
        fi
    fi

    # fallback: 没有 timeout 命令
    echo "  [超时保护] ${description}: 最长等待 ${timeout_secs}s (fallback 模式)"
    "$@" &
    local cmd_pid=$!
    (
        sleep "$timeout_secs" 2>/dev/null
        if kill -0 "$cmd_pid" 2>/dev/null; then
            echo "  ⏰ [超时] ${description} 超过 ${timeout_secs}s，正在终止..."
            kill -TERM "$cmd_pid" 2>/dev/null
            sleep 5
            kill -0 "$cmd_pid" 2>/dev/null && kill -KILL "$cmd_pid" 2>/dev/null
        fi
    ) &
    local watchdog_pid=$!
    wait "$cmd_pid" 2>/dev/null
    local rc=$?
    kill "$watchdog_pid" 2>/dev/null
    wait "$watchdog_pid" 2>/dev/null 2>&1
    if [ $rc -eq 143 ] || [ $rc -eq 137 ]; then
        return 124
    fi
    return $rc
}

# ============================================================================
#  参数解析
# ============================================================================
PKG_NAME="@tencent-connect/openclaw-qqbot"
PLUGIN_ID="openclaw-qqbot"
INSTALL_SRC=""
TARGET_VERSION=""
INSTALL_TIMEOUT=300
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag|--version)
            [ -z "$2" ] && echo "❌ $1 需要参数" && exit 1
            TARGET_VERSION="${2#v}"
            shift 2
            ;;
        --self-version)
            LOCAL_VERSION="$(read_pkg_version "$PROJECT_DIR/package.json")"
            [ -z "$LOCAL_VERSION" ] && echo "❌ 无法从 package.json 读取版本" && exit 1
            TARGET_VERSION="$LOCAL_VERSION"
            shift 1
            ;;
        --pkg)
            [ -z "$2" ] && echo "❌ --pkg 需要参数" && exit 1
            _pkg="$2"
            if [[ "$_pkg" != @* ]]; then _pkg="@$_pkg"; fi
            PKG_NAME="$_pkg"
            shift 2
            ;;
        --timeout)
            [ -z "$2" ] && echo "❌ --timeout 需要参数" && exit 1
            INSTALL_TIMEOUT="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift 1
            ;;
        -h|--help)
            echo "用法:"
            echo "  install-via-npm-pack.sh                          # 安装 latest"
            echo "  install-via-npm-pack.sh --version <版本号>        # 安装指定版本"
            echo "  install-via-npm-pack.sh --pkg <scope/name>       # 指定 npm 包名"
            echo "  install-via-npm-pack.sh --timeout 600            # 自定义超时（秒）"
            echo "  install-via-npm-pack.sh --dry-run                # 只下载解压，不部署"
            exit 0
            ;;
        *) echo "未知选项: $1"; exit 1 ;;
    esac
done

# 拼接 INSTALL_SRC
if [ -n "$TARGET_VERSION" ]; then
    INSTALL_SRC="${PKG_NAME}@${TARGET_VERSION}"
else
    INSTALL_SRC="${PKG_NAME}@latest"
fi

# 检测 CLI
CMD=""
for name in openclaw clawdbot moltbot; do
    command -v "$name" &>/dev/null && CMD="$name" && break
done
[ -z "$CMD" ] && echo "❌ 未找到 openclaw / clawdbot / moltbot" && exit 1

EXTENSIONS_DIR="$HOME/.$CMD/extensions"
CONFIG_FILE="$HOME/.$CMD/$CMD.json"

# 检测 openclaw 版本
OPENCLAW_VERSION="$($CMD --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true)"

echo "==========================================="
echo "  npm pack 安装验证: $INSTALL_SRC"
echo "  openclaw CLI: $CMD (v${OPENCLAW_VERSION:-unknown})"
echo "  进程隔离: ${_UPGRADE_ISOLATED:+✓ setsid}${_UPGRADE_ISOLATED:-✗ 未隔离}"
echo "  extensions 目录: $EXTENSIONS_DIR"
echo "  配置文件: $CONFIG_FILE"
echo "  超时: ${INSTALL_TIMEOUT}s"
echo "  dry-run: $DRY_RUN"
echo "==========================================="
echo ""

# 记录旧版本
OLD_VERSION=""
OLD_PKG="$EXTENSIONS_DIR/$PLUGIN_ID/package.json"
if [ -f "$OLD_PKG" ]; then
    OLD_VERSION="$(read_pkg_version "$OLD_PKG")"
    echo "  当前已安装版本: ${OLD_VERSION:-unknown}"
    echo ""
fi

# ============================================================================
#  前置检查
# ============================================================================
echo "[0/5] 前置检查..."

if ! command -v npm &>/dev/null; then
    echo "  ❌ npm 命令不可用"
    exit 1
fi
echo "  ✅ npm: $(npm --version 2>/dev/null)"

if ! command -v tar &>/dev/null; then
    echo "  ❌ tar 命令不可用"
    exit 1
fi
echo "  ✅ tar: 可用"

if ! command -v node &>/dev/null; then
    echo "  ❌ node 命令不可用"
    exit 1
fi
echo "  ✅ node: $(node --version 2>/dev/null)"

echo ""

# ============================================================================
#  Step 1: npm pack 下载 tgz（多 registry 兜底）
# ============================================================================
echo "[1/5] 下载 npm 包: $INSTALL_SRC"

pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/.qqbot-pack-XXXXXX")"
extract_dir="$(mktemp -d "${TMPDIR:-/tmp}/.qqbot-extract-XXXXXX")"

# 清理函数（含异常退出时的备份回滚）
cleanup_on_exit() {
    local exit_code=$?
    [ -n "$pack_dir" ] && [ -d "$pack_dir" ] && rm -rf "$pack_dir" 2>/dev/null || true
    [ -n "$extract_dir" ] && [ -d "$extract_dir" ] && rm -rf "$extract_dir" 2>/dev/null || true
    # 异常退出时：如果有备份且目标目录不完整，执行回滚
    if [ $exit_code -ne 0 ] && [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR/$PLUGIN_ID" ]; then
        local _target="$EXTENSIONS_DIR/$PLUGIN_ID"
        if [ ! -d "$_target" ] || [ ! -f "$_target/package.json" ]; then
            rm -rf "$_target" 2>/dev/null || true
            mv "$BACKUP_DIR/$PLUGIN_ID" "$_target" 2>/dev/null || cp -a "$BACKUP_DIR/$PLUGIN_ID" "$_target" 2>/dev/null || true
            echo "  ↩️  [cleanup] 异常退出，已回滚到旧版本"
        fi
    fi
    # 清理备份目录
    [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ] && rm -rf "$BACKUP_DIR" 2>/dev/null || true
}
trap cleanup_on_exit EXIT
# 增强信号处理：捕获 SIGTERM/SIGINT/SIGHUP，确保 cleanup 能执行
trap 'echo "  ⚠️  收到 SIGTERM 信号"; exit 143' TERM
trap 'echo "  ⚠️  收到 SIGINT 信号"; exit 130' INT
trap 'echo "  ⚠️  收到 SIGHUP 信号"; exit 129' HUP
BACKUP_DIR=""  # 提前声明，供 cleanup_on_exit 引用

# 清理上次安装可能遗留的临时目录（如上次脚本被 kill 等极端情况）
find "${TMPDIR:-/tmp}" -maxdepth 1 -name ".qqbot-upgrade-backup-*" -mmin +60 -exec rm -rf {} + 2>/dev/null || true
find "${TMPDIR:-/tmp}" -maxdepth 1 -name ".qqbot-pack-*" -mmin +60 -exec rm -rf {} + 2>/dev/null || true
find "${TMPDIR:-/tmp}" -maxdepth 1 -name ".qqbot-extract-*" -mmin +60 -exec rm -rf {} + 2>/dev/null || true

pack_ok=false
# 多 registry 兜底（npm 官方 → 腾讯云镜像）
registries=("https://registry.npmjs.org/" "https://mirrors.cloud.tencent.com/npm/")

for registry in "${registries[@]}"; do
    pack_args=("pack" "$INSTALL_SRC" "--pack-destination" "$pack_dir")
    if [ -n "$registry" ]; then
        pack_args+=("--registry" "$registry")
        echo "  尝试 registry: $registry"
    else
        echo "  尝试默认 registry..."
    fi

    if run_with_timeout "$INSTALL_TIMEOUT" "npm pack $INSTALL_SRC" npm "${pack_args[@]}" 2>&1; then
        pack_ok=true
        echo "  ✅ npm pack 成功 (registry: ${registry:-default})"
        break
    else
        echo "  ⚠️  此 registry 失败，尝试下一个..."
    fi
done

if [ "$pack_ok" != "true" ]; then
    echo ""
    echo "❌ npm pack 失败（所有 registry 均不可用）"
    exit 1
fi

# 找到下载的 tgz 文件
tgz_file="$(find "$pack_dir" -maxdepth 1 -name '*.tgz' -type f | head -1)"
if [ -z "$tgz_file" ] || [ ! -f "$tgz_file" ]; then
    echo "❌ 未找到下载的 tgz 文件"
    exit 1
fi
tgz_size="$(wc -c < "$tgz_file" 2>/dev/null | tr -d ' ')"
echo "  已下载: $(basename "$tgz_file") (${tgz_size} bytes)"
echo ""

# ============================================================================
#  Step 2: 解压 tgz
# ============================================================================
echo "[2/5] 解压 tgz..."
if ! tar xzf "$tgz_file" -C "$extract_dir" 2>&1; then
    echo "❌ 解压失败"
    exit 1
fi

# npm pack 解压后的目录名为 "package"
package_dir="$extract_dir/package"
if [ ! -d "$package_dir" ] || [ ! -f "$package_dir/package.json" ]; then
    echo "❌ 解压后未找到 package 目录或 package.json"
    echo "  extract_dir 内容:"
    ls -la "$extract_dir" 2>/dev/null || true
    exit 1
fi

# 读取版本号
NEW_VERSION="$(read_pkg_version "$package_dir/package.json")"
echo "  ✅ 解压成功: v${NEW_VERSION:-unknown}"

echo ""

# ============================================================================
#  Step 3: 检查 bundled dependencies
# ============================================================================
echo "[3/5] 检查 bundled dependencies..."
nm_dir="$package_dir/node_modules"
_need_npm_install=false

if [ -d "$nm_dir" ]; then
    bundled_count="$(find "$nm_dir" -maxdepth 2 -name 'package.json' -type f 2>/dev/null | wc -l | tr -d ' ')"
    echo "  ✅ bundled dependencies 就绪（${bundled_count} 个包）"

    # 检查关键依赖（ws 为致命级，缺失则尝试 npm install 补救）
    for dep in "ws" "silk-wasm"; do
        if [ -d "$nm_dir/$dep" ]; then
            dep_ver="$(read_pkg_version "$nm_dir/$dep/package.json")"
            echo "    ✅ $dep@${dep_ver:-unknown}"
        else
            if [ "$dep" = "ws" ]; then
                echo "    ❌ $dep 缺失（致命：WebSocket 网关无法启动），尝试 npm install 补救..."
                _need_npm_install=true
            else
                echo "    ⚠️  $dep 缺失（语音功能不可用，文字消息不受影响）"
            fi
        fi
    done
else
    echo "  ⚠️  bundled node_modules 不存在"
    _need_npm_install=true
fi

# 需要 npm install 补救时执行
if [ "$_need_npm_install" = "true" ]; then
    echo "  执行 npm install --omit=dev..."
    ensure_valid_cwd
    if ! run_with_timeout 120 "npm install" bash -c "cd '$package_dir' && npm install --omit=dev --omit=peer --ignore-scripts --quiet" 2>&1; then
        echo "  ⚠️  npm install 失败或超时"
    fi
    if [ -d "$nm_dir" ] && [ -d "$nm_dir/ws" ]; then
        bundled_count="$(find "$nm_dir" -maxdepth 2 -name 'package.json' -type f 2>/dev/null | wc -l | tr -d ' ')"
        echo "  ✅ npm install 完成（${bundled_count} 个包）"
    else
        echo "  ❌ npm install 后关键依赖 ws 仍不存在，中止安装"
        exit 1
    fi
fi
echo ""

# ============================================================================
#  Preflight 验证（部署前检查）
# ============================================================================
echo "[验证] 部署前完整性检查..."
PREFLIGHT_OK=true

# 入口文件
ENTRY_FILE=""
for candidate in "dist/index.js" "index.js"; do
    if [ -f "$package_dir/$candidate" ]; then
        ENTRY_FILE="$candidate"
        break
    fi
done
if [ -z "$ENTRY_FILE" ]; then
    echo "  ❌ 缺少入口文件（dist/index.js 或 index.js）"
    PREFLIGHT_OK=false
else
    echo "  ✅ 入口文件: $ENTRY_FILE"
fi

# 核心目录
if [ -d "$package_dir/dist/src" ]; then
    CORE_JS_COUNT=$(find "$package_dir/dist/src" -name "*.js" -type f 2>/dev/null | wc -l | tr -d ' ')
    echo "  ✅ dist/src/ 包含 ${CORE_JS_COUNT} 个 JS 文件"
    if [ "$CORE_JS_COUNT" -lt 5 ]; then
        echo "  ❌ JS 文件数量异常偏少（预期 ≥ 5，实际 ${CORE_JS_COUNT}）"
        PREFLIGHT_OK=false
    fi
else
    echo "  ❌ 缺少核心目录 dist/src/"
    PREFLIGHT_OK=false
fi

# 关键模块
MISSING_MODULES=""
for module in "dist/src/gateway.js" "dist/src/api.js" "dist/src/admin-resolver.js"; do
    if [ ! -f "$package_dir/$module" ]; then
        MISSING_MODULES="$MISSING_MODULES $module"
    fi
done
if [ -n "$MISSING_MODULES" ]; then
    echo "  ❌ 缺少关键模块:$MISSING_MODULES"
    PREFLIGHT_OK=false
else
    echo "  ✅ 关键模块完整"
fi

if [ "$PREFLIGHT_OK" != "true" ]; then
    echo ""
    echo "❌ 部署前验证未通过，中止安装"
    exit 1
fi
echo "  ✅ 部署前验证全部通过"
echo ""

# ============================================================================
#  dry-run 模式：到此为止
# ============================================================================
if [ "$DRY_RUN" = "true" ]; then
    echo "==========================================="
    echo "  🏁 dry-run 模式：下载、解压、验证均通过"
    echo "  包: $INSTALL_SRC"
    echo "  版本: v${NEW_VERSION:-unknown}"
    echo "  tgz: $(basename "$tgz_file") (${tgz_size} bytes)"
    echo "  临时目录: $package_dir"
    echo ""
    echo "  如需实际部署，去掉 --dry-run 参数重新运行"
    echo "==========================================="
    # dry-run 不清理临时目录，方便检查
    trap - EXIT
    exit 0
fi

# ============================================================================
#  Step 4: 部署到 extensions 目录
# ============================================================================
# 回滚并退出的辅助函数（消除重复代码）
rollback_and_exit() {
    local reason="$1"
    echo "  ❌ $reason"
    rm -rf "$target_dir" 2>/dev/null || true
    if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR/$PLUGIN_ID" ]; then
        mv "$BACKUP_DIR/$PLUGIN_ID" "$target_dir" 2>/dev/null || cp -a "$BACKUP_DIR/$PLUGIN_ID" "$target_dir"
        echo "  ↩️  已回滚到旧版本"
    fi
    exit 1
}

echo "[4/5] 部署到 extensions 目录..."
target_dir="$EXTENSIONS_DIR/$PLUGIN_ID"

# 确保 extensions 目录存在
mkdir -p "$EXTENSIONS_DIR" 2>/dev/null || true

# 清理历史遗留的插件目录名（旧版本可能使用不同的目录名）
for dir_name in qqbot openclaw-qq; do
    [ -d "$EXTENSIONS_DIR/$dir_name" ] && rm -rf "$EXTENSIONS_DIR/$dir_name" && echo "  已清理历史目录: $EXTENSIONS_DIR/$dir_name"
done

# 备份旧目录
if [ -d "$target_dir" ]; then
    BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/.qqbot-upgrade-backup-XXXXXX")"
    echo "  备份旧目录: cp -a $target_dir → $BACKUP_DIR/$PLUGIN_ID"
    cp -a "$target_dir" "$BACKUP_DIR/$PLUGIN_ID"
    echo "  删除旧目录: rm -rf $target_dir"
    rm -rf "$target_dir"
    # 验证旧目录确实被删除（极少触发，仅在进程占用等极端情况）
    if [ -d "$target_dir" ]; then
        echo "  ⚠️  rm -rf 未能完全删除旧目录，等待 1s 后重试..."
        sleep 1
        rm -rf "$target_dir" 2>/dev/null || true
        if [ -d "$target_dir" ]; then
            rollback_and_exit "无法删除旧目录，中止部署"
        fi
    fi
    echo "  ✅ 旧目录已删除"
fi

# 移动到目标位置（此时 target_dir 一定不存在）
echo "  mv $package_dir → $target_dir"
MV_OUTPUT=""
MV_OUTPUT=$(mv "$package_dir" "$target_dir" 2>&1)
MV_RC=$?
if [ $MV_RC -ne 0 ]; then
    echo "  [诊断] mv 输出: $MV_OUTPUT"
    rollback_and_exit "移动到 extensions 目录失败 (exit=$MV_RC)"
fi

# 验证部署结果
if [ ! -d "$target_dir" ] || [ ! -f "$target_dir/package.json" ]; then
    echo "  [诊断] target_dir 存在: $([ -d "$target_dir" ] && echo '是' || echo '否')"
    echo "  [诊断] package.json 存在: $([ -f "$target_dir/package.json" ] && echo '是' || echo '否')"
    rollback_and_exit "部署后目录不完整"
fi
echo "  ✅ 已部署到: $target_dir"
echo ""

# ============================================================================
#  Step 5: 写入配置 + 执行 postinstall
# ============================================================================
echo "[5/5] 写入配置并创建 SDK symlink..."

# 写入 plugins.installs / plugins.entries / plugins.allow 到配置文件
if [ -f "$CONFIG_FILE" ]; then
    node -e "
      try {
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
        if (!cfg.plugins) cfg.plugins = {};
        // 写入 installs 记录
        if (!cfg.plugins.installs) cfg.plugins.installs = {};
        cfg.plugins.installs['$PLUGIN_ID'] = {
          source: 'npm',
          spec: '$INSTALL_SRC',
          version: '$NEW_VERSION'
        };
        // 写入 entries 记录
        if (!cfg.plugins.entries) cfg.plugins.entries = {};
        if (!cfg.plugins.entries['$PLUGIN_ID']) {
          cfg.plugins.entries['$PLUGIN_ID'] = { enabled: true };
        }
        // 确保 allow 列表包含插件
        if (!cfg.plugins.allow) cfg.plugins.allow = [];
        if (!cfg.plugins.allow.includes('$PLUGIN_ID')) {
          cfg.plugins.allow.push('$PLUGIN_ID');
        }
        fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 4) + '\n');
        console.log('  ✅ 已写入 plugins.installs/entries/allow 配置');
      } catch(e) {
        console.error('  ⚠️  写入配置失败:', e.message);
      }
    " 2>/dev/null || echo "  ⚠️  写入配置失败"
else
    echo "  ⚠️  配置文件不存在: $CONFIG_FILE"
fi

# 执行 postinstall-link-sdk.js 创建 openclaw SDK symlink
postinstall_script="$target_dir/scripts/postinstall-link-sdk.js"
if [ -f "$postinstall_script" ]; then
    echo "  执行 postinstall-link-sdk..."
    if node "$postinstall_script" 2>&1; then
        echo "  ✅ plugin-sdk 链接就绪"
    else
        echo "  ⚠️  postinstall-link-sdk 失败（非致命）"
    fi
else
    echo "  ⚠️  postinstall-link-sdk.js 不存在，跳过"
fi

# 清理备份
if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
    rm -rf "$BACKUP_DIR"
    echo "  已清理旧版备份"
fi
echo ""

# ============================================================================
#  安装结果
# ============================================================================
echo "==========================================="
echo "  ✅ npm pack 安装完成"
echo ""
echo "  包: $INSTALL_SRC"
echo "  版本: v${NEW_VERSION:-unknown}"
if [ -n "$OLD_VERSION" ]; then
    if [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
        echo "  变更: 无（已是最新版）"
    else
        echo "  变更: v${OLD_VERSION} → v${NEW_VERSION}"
    fi
fi
echo "  目录: $target_dir"
echo "  配置: $CONFIG_FILE"
echo "==========================================="
echo ""

# 输出结构化信息（供调用方解析）
echo "QQBOT_NEW_VERSION=${NEW_VERSION:-unknown}"
if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" != "unknown" ]; then
    echo "QQBOT_REPORT=✅ QQBot npm pack 安装完成: v${NEW_VERSION}"
else
    echo "QQBOT_REPORT=⚠️ QQBot npm pack 安装异常，无法确认版本"
fi
