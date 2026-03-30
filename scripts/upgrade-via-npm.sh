#!/bin/bash

# qqbot 通过 openclaw 原生插件指令升级
#
# 使用 openclaw plugins install/update 原生命令进行安装和升级，
# 保留 appid/secret 配置写入、热更新 (--no-restart)、结构化输出等功能。
#
# 升级策略：
#   1. 已安装（plugins.installs 有记录）→ openclaw plugins update
#   2. 未安装 / update 失败 → 删除旧目录 + openclaw plugins install
#
# 用法:
#   upgrade-via-npm.sh                                    # 升级到 latest（默认）
#   upgrade-via-npm.sh --version <version>                # 升级到指定版本
#   upgrade-via-npm.sh --self-version                     # 升级到当前仓库 package.json 版本
#   upgrade-via-npm.sh --appid <appid> --secret <secret>  # 首次安装时配置 appid/secret
#   upgrade-via-npm.sh --no-restart                       # 只做文件替换，不重启 gateway（供热更指令使用）

set -eo pipefail

# ⚠️ 必须在 cd 之前解析脚本路径，否则相对路径的 $0 在 cd 后无法正确解析
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 确保 cwd 是一个存在的目录。
# 当从 gateway 进程 fork 时，继承的 cwd 可能已被删除（如旧插件目录被 mv/rm），
# 导致 openclaw CLI 启动时 process.cwd() 报 ENOENT: uv_cwd 错误。
cd "$HOME" 2>/dev/null || cd / 2>/dev/null || true

# 异常退出时清理临时文件并回滚（防止泄露或残留）
INSTALL_COMPLETED=false  # 标记 install 是否已完成（用于区分正常退出和异常退出）
cleanup_on_exit() {
    local exit_code=$?

    # 异常退出时同步临时配置中的 install 记录回真实配置
    if [ -n "$TEMP_CONFIG_FILE" ] && [ -f "$TEMP_CONFIG_FILE" ]; then
        # 尝试同步 install 记录（即使异常退出也要保留）
        node -e "
          try {
            const fs = require('fs');
            const tmp = JSON.parse(fs.readFileSync('$TEMP_CONFIG_FILE', 'utf8'));
            const real = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
            if (tmp.plugins && tmp.plugins.installs) {
              if (!real.plugins) real.plugins = {};
              real.plugins.installs = { ...(real.plugins.installs || {}), ...tmp.plugins.installs };
            }
            if (tmp.plugins && tmp.plugins.entries) {
              if (!real.plugins) real.plugins = {};
              real.plugins.entries = { ...(real.plugins.entries || {}), ...tmp.plugins.entries };
            }
            fs.writeFileSync('$CONFIG_FILE', JSON.stringify(real, null, 4) + '\n');
          } catch {}
        " 2>/dev/null || true
        rm -f "$TEMP_CONFIG_FILE" 2>/dev/null || true
    fi

    # 异常退出且 install 未完成时，回滚备份目录（而非删除）
    if [ "$INSTALL_COMPLETED" != "true" ] && [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
        if [ ! -d "$EXTENSIONS_DIR/$PLUGIN_ID" ] || [ ! -f "$EXTENSIONS_DIR/$PLUGIN_ID/package.json" ]; then
            # 插件目录不存在或不完整，回滚
            rm -rf "$EXTENSIONS_DIR/$PLUGIN_ID" 2>/dev/null || true
            mv "$BACKUP_DIR/$PLUGIN_ID" "$EXTENSIONS_DIR/$PLUGIN_ID" 2>/dev/null || \
            mv "$BACKUP_DIR"/* "$EXTENSIONS_DIR/$PLUGIN_ID" 2>/dev/null || true
            echo "  ↩️  [cleanup] 异常退出，已回滚到旧版本"
        else
            # 插件目录完整，清理备份
            rm -rf "$BACKUP_DIR" 2>/dev/null || true
        fi
    elif [ "$INSTALL_COMPLETED" = "true" ] && [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
        # 正常完成，清理备份
        rm -rf "$BACKUP_DIR" 2>/dev/null || true
    fi

    # 清理 openclaw install 可能残留的暂存目录（extensions 和 /tmp 中都可能存在）
    find "${EXTENSIONS_DIR:-/dev/null}" -maxdepth 1 -name ".openclaw-install-stage-*" -exec rm -rf {} + 2>/dev/null || true
    find "${TMPDIR:-/tmp}" -maxdepth 1 -name ".openclaw-install-stage-*" -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup_on_exit EXIT

# 清理上次升级可能遗留的备份目录（如上次脚本被 kill 等极端情况）
find "${TMPDIR:-/tmp}" -maxdepth 1 -name ".qqbot-upgrade-backup-*" -exec rm -rf {} + 2>/dev/null || true

PKG_NAME="@tencent-connect/openclaw-qqbot"
PLUGIN_ID="openclaw-qqbot"
INSTALL_SRC=""
TARGET_VERSION=""
APPID=""
SECRET=""
NO_RESTART=false

LOCAL_VERSION="$(node -e "
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join('$PROJECT_DIR', 'package.json');
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    if (v) process.stdout.write(String(v));
  } catch {}
" 2>/dev/null || true)"

print_usage() {
    echo "用法:"
    echo "  upgrade-via-npm.sh                              # 升级到 latest（默认）"
    echo "  upgrade-via-npm.sh --version <版本号>            # 升级到指定版本"
    if [ -n "$LOCAL_VERSION" ]; then
        echo "  upgrade-via-npm.sh --self-version               # 升级到当前仓库版本（$LOCAL_VERSION）"
    else
        echo "  upgrade-via-npm.sh --self-version               # 升级到当前仓库版本"
    fi
    echo ""
    echo "  --pkg <scope/name>    指定 npm 包名（如 ryantest/openclaw-qqbot）"
    echo "  --appid <appid>       QQ机器人 appid（首次安装时必填）"
    echo "  --secret <secret>     QQ机器人 secret（首次安装时必填）"
    echo ""
    echo "也可以通过环境变量设置:"
    echo "  QQBOT_APPID           QQ机器人 appid"
    echo "  QQBOT_SECRET          QQ机器人 secret"
    echo "  QQBOT_TOKEN           QQ机器人 token (appid:secret)"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag)
            [ -z "$2" ] && echo "❌ --tag 需要参数" && exit 1
            TARGET_VERSION="${2#v}"  # 去掉 v 前缀（npm 版本号不带 v）
            shift 2
            ;;
        --version)
            [ -z "$2" ] && echo "❌ --version 需要参数" && exit 1
            TARGET_VERSION="${2#v}"  # 去掉 v 前缀（npm 版本号不带 v）
            shift 2
            ;;
        --self-version)
            [ -z "$LOCAL_VERSION" ] && echo "❌ 无法从 package.json 读取版本" && exit 1
            TARGET_VERSION="$LOCAL_VERSION"
            shift 1
            ;;
        --appid)
            [ -z "$2" ] && echo "❌ --appid 需要参数" && exit 1
            APPID="$2"
            shift 2
            ;;
        --secret)
            [ -z "$2" ] && echo "❌ --secret 需要参数" && exit 1
            SECRET="$2"
            shift 2
            ;;
        --pkg)
            [ -z "$2" ] && echo "❌ --pkg 需要参数" && exit 1
            _pkg="$2"
            # 支持 "scope/name" 自动补 @
            if [[ "$_pkg" != @* ]]; then _pkg="@$_pkg"; fi
            PKG_NAME="$_pkg"
            shift 2
            ;;
        --no-restart)
            NO_RESTART=true
            shift 1
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *) echo "未知选项: $1"; print_usage; exit 1 ;;
    esac
done
# 参数解析完毕后统一拼接 INSTALL_SRC（确保 --pkg 无论在 --version 前后都能生效）
if [ -n "$TARGET_VERSION" ]; then
    INSTALL_SRC="${PKG_NAME}@${TARGET_VERSION}"
else
    INSTALL_SRC="${PKG_NAME}@latest"
fi

# 环境变量 fallback
APPID="${APPID:-$QQBOT_APPID}"
SECRET="${SECRET:-$QQBOT_SECRET}"
if [ -z "$APPID" ] && [ -z "$SECRET" ] && [ -n "$QQBOT_TOKEN" ]; then
    APPID="${QQBOT_TOKEN%%:*}"
    SECRET="${QQBOT_TOKEN#*:}"
fi

# 检测 CLI
CMD=""
for name in openclaw clawdbot moltbot; do
    command -v "$name" &>/dev/null && CMD="$name" && break
done
[ -z "$CMD" ] && echo "❌ 未找到 openclaw / clawdbot / moltbot" && exit 1

EXTENSIONS_DIR="$HOME/.$CMD/extensions"

# 检测 openclaw 版本
OPENCLAW_VERSION="$($CMD --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true)"

echo "==========================================="
echo "  qqbot 升级: $INSTALL_SRC"
echo "  openclaw 版本: ${OPENCLAW_VERSION:-unknown}"
echo "==========================================="
echo ""

# 记录升级前的版本
OLD_VERSION=""
OLD_PKG="$EXTENSIONS_DIR/$PLUGIN_ID/package.json"
if [ -f "$OLD_PKG" ]; then
    OLD_VERSION="$(node -e "
      try {
        const v = JSON.parse(require('fs').readFileSync('$OLD_PKG', 'utf8')).version;
        if (v) process.stdout.write(String(v));
      } catch {}
    " 2>/dev/null || true)"
    echo "  当前版本: ${OLD_VERSION:-unknown}"
fi

# [1/4] 通过 openclaw 原生指令安装/升级
echo ""
echo "[1/4] 安装/升级插件..."

# ── 兼容 openclaw 3.23+ 配置严格校验 ──
# 3.23+ 在 plugins install/update 时会校验整个配置文件，
# 如果 channels.qqbot 已存在但 qqbot 插件尚未加载，校验会失败。
#
# ⚠️ 关键：绝不能直接修改真实的 openclaw.json，否则 gateway 的 config file watcher
#    会检测到变更并触发 SIGUSR1 重启，导致正在执行的升级脚本被杀死。
#
# 解决：创建临时配置副本（不含 channels.qqbot），通过 OPENCLAW_CONFIG_PATH
#       环境变量让 plugins install/update 使用临时配置，真实配置文件不受影响。
CONFIG_FILE="$HOME/.$CMD/$CMD.json"
TEMP_CONFIG_FILE=""
NEEDS_TEMP_CONFIG=false

if [ -f "$CONFIG_FILE" ]; then
    NEEDS_TEMP_CONFIG="$(node -e "
      try {
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
        const hasChannel = !!(cfg.channels && cfg.channels.qqbot);
        const hasAllow = Array.isArray(cfg.plugins?.allow) && cfg.plugins.allow.includes('$PLUGIN_ID');
        const hasEntry = !!(cfg.plugins?.entries?.['$PLUGIN_ID']);
        if (hasChannel || hasAllow || hasEntry) process.stdout.write('true');
      } catch {}
    " 2>/dev/null || true)"

    if [ "$NEEDS_TEMP_CONFIG" = "true" ]; then
        TEMP_CONFIG_FILE="$(mktemp)"
        node -e "
          try {
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
            // 移除 channels.qqbot（插件自定义通道，校验时会 unknown channel id）
            if (cfg.channels?.qqbot) {
              delete cfg.channels.qqbot;
              if (Object.keys(cfg.channels).length === 0) delete cfg.channels;
            }
            // 移除 plugins.allow 中的 openclaw-qqbot（插件目录被备份后校验找不到）
            if (Array.isArray(cfg.plugins?.allow)) {
              cfg.plugins.allow = cfg.plugins.allow.filter(p => p !== '$PLUGIN_ID');
              if (cfg.plugins.allow.length === 0) delete cfg.plugins.allow;
            }
            // 移除 plugins.entries 中的 openclaw-qqbot（同理）
            if (cfg.plugins?.entries?.['$PLUGIN_ID']) {
              delete cfg.plugins.entries['$PLUGIN_ID'];
              if (Object.keys(cfg.plugins.entries).length === 0) delete cfg.plugins.entries;
            }
            fs.writeFileSync('$TEMP_CONFIG_FILE', JSON.stringify(cfg, null, 4) + '\n');
          } catch(e) { process.exit(1); }
        " 2>/dev/null
        if [ $? -eq 0 ]; then
            echo "  [兼容] 创建临时配置副本（不含 channels.qqbot / plugins.allow / plugins.entries）以通过配置校验"
            export OPENCLAW_CONFIG_PATH="$TEMP_CONFIG_FILE"
        else
            echo "  ⚠️  创建临时配置失败，继续使用原配置"
            TEMP_CONFIG_FILE=""
        fi
    fi
fi

# 清理临时配置的函数
# plugins install/update 可能把 install 记录写入了临时配置，需要同步回真实配置
restore_qqbot_channel() {
    if [ -n "$TEMP_CONFIG_FILE" ] && [ -f "$TEMP_CONFIG_FILE" ]; then
        # 将临时配置中 plugins.installs 和 plugins.entries 的变更同步回真实配置
        node -e "
          try {
            const fs = require('fs');
            const tmp = JSON.parse(fs.readFileSync('$TEMP_CONFIG_FILE', 'utf8'));
            const real = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
            let changed = false;
            if (tmp.plugins && tmp.plugins.installs) {
              if (!real.plugins) real.plugins = {};
              real.plugins.installs = { ...(real.plugins.installs || {}), ...tmp.plugins.installs };
              changed = true;
            }
            // 同步 plugins.entries（openclaw plugins install 会写入 entries）
            if (tmp.plugins && tmp.plugins.entries) {
              if (!real.plugins) real.plugins = {};
              real.plugins.entries = { ...(real.plugins.entries || {}), ...tmp.plugins.entries };
              changed = true;
            }
            if (changed) {
              fs.writeFileSync('$CONFIG_FILE', JSON.stringify(real, null, 4) + '\n');
            }
          } catch {}
        " 2>/dev/null || true
        rm -f "$TEMP_CONFIG_FILE"
        unset OPENCLAW_CONFIG_PATH
        echo "  [兼容] 已同步 install/entries 记录并清理临时配置副本"
    fi
}

UPGRADE_OK=false

# 检测安装状态：同时检查配置记录和磁盘目录
HAS_INSTALL_RECORD="$(node -e "
  try {
    const fs = require('fs');
    const p = '$HOME/.$CMD/$CMD.json';
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const inst = cfg.plugins && cfg.plugins.installs && cfg.plugins.installs['$PLUGIN_ID'];
    if (inst) process.stdout.write('yes');
  } catch {}
" 2>/dev/null || true)"
HAS_PLUGIN_DIR=false
[ -d "$EXTENSIONS_DIR/$PLUGIN_ID" ] && [ -f "$EXTENSIONS_DIR/$PLUGIN_ID/package.json" ] && HAS_PLUGIN_DIR=true

# 决策矩阵：
#   配置有记录 + 目录存在 → update（最佳路径）
#   配置有记录 + 目录不存在 → 清理残留记录，走 install
#   配置无记录 + 目录存在 → 删目录，走 install（配置与文件不一致）
#   配置无记录 + 目录不存在 → 走 install（全新安装）
#
# 指定了具体版本（--version/--tag/--self-version）时：
#   update 不支持指定版本，直接走 删除 + install

USE_UPDATE=false

if [ "$HAS_INSTALL_RECORD" = "yes" ] && [ "$HAS_PLUGIN_DIR" = "true" ] && [ -z "$TARGET_VERSION" ]; then
    # 配置和目录都齐全，且未指定版本 → 走 update
    USE_UPDATE=true
    echo "  [检测] 配置记录 ✓ | 插件目录 ✓ | 未指定版本 → 使用 update"
elif [ "$HAS_INSTALL_RECORD" = "yes" ] && [ "$HAS_PLUGIN_DIR" = "true" ]; then
    echo "  [检测] 配置记录 ✓ | 插件目录 ✓ | 指定版本 $TARGET_VERSION → 使用 reinstall"
elif [ "$HAS_INSTALL_RECORD" = "yes" ]; then
    echo "  [检测] 配置记录 ✓ | 插件目录 ✗ → 配置与文件不一致，使用 install"
elif [ "$HAS_PLUGIN_DIR" = "true" ]; then
    echo "  [检测] 配置记录 ✗ | 插件目录 ✓ → 目录残留，清理后 install"
else
    echo "  [检测] 配置记录 ✗ | 插件目录 ✗ → 全新安装"
fi

if [ "$USE_UPDATE" = "true" ]; then
    echo "  尝试 update..."
    if $CMD plugins update "$PLUGIN_ID" 2>&1; then
        # update 返回 0 不一定真的更新了，检查版本是否变化
        POST_UPDATE_VERSION=""
        if [ -f "$OLD_PKG" ]; then
            POST_UPDATE_VERSION="$(node -e "
              try {
                const v = JSON.parse(require('fs').readFileSync('$OLD_PKG', 'utf8')).version;
                if (v) process.stdout.write(String(v));
              } catch {}
            " 2>/dev/null || true)"
        fi
        if [ -n "$POST_UPDATE_VERSION" ] && [ "$POST_UPDATE_VERSION" != "$OLD_VERSION" ]; then
            UPGRADE_OK=true
            echo "  ✅ update 成功 ($OLD_VERSION → $POST_UPDATE_VERSION)"
        elif [ -z "$OLD_VERSION" ]; then
            # 之前没有旧版本，无法比较，信任 update 结果
            UPGRADE_OK=true
            echo "  ✅ update 成功"
        else
            echo "  ⚠️  update 返回成功但版本未变 ($POST_UPDATE_VERSION)，回退到 reinstall..."
        fi
    else
        echo "  ⚠️  update 失败，回退到 reinstall..."
    fi
fi

if [ "$UPGRADE_OK" != "true" ]; then
    # 备份旧目录（而非直接删除），install 失败时可回滚
    BACKUP_DIR=""
    if [ -d "$EXTENSIONS_DIR/$PLUGIN_ID" ]; then
        BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/.qqbot-upgrade-backup-XXXXXX")"
        mv "$EXTENSIONS_DIR/$PLUGIN_ID" "$BACKUP_DIR"
        echo "  已备份旧目录: $BACKUP_DIR"
    fi

    # 清理历史遗留名称（这些不需要回滚）
    for dir_name in qqbot openclaw-qq; do
        [ -d "$EXTENSIONS_DIR/$dir_name" ] && rm -rf "$EXTENSIONS_DIR/$dir_name" && echo "  已清理历史目录: $EXTENSIONS_DIR/$dir_name"
    done

    echo "  执行 install: $INSTALL_SRC"

    if $CMD plugins install "$INSTALL_SRC" --pin 2>&1; then
        # install 返回 0，但需要验证插件目录是否真的存在且完整
        if [ -d "$EXTENSIONS_DIR/$PLUGIN_ID" ] && [ -f "$EXTENSIONS_DIR/$PLUGIN_ID/package.json" ]; then
            UPGRADE_OK=true
            INSTALL_COMPLETED=true
            echo "  ✅ install 成功"
            # install 成功，清理备份
            if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
                rm -rf "$BACKUP_DIR"
                echo "  已清理旧版备份"
            fi
            # 清理 openclaw CLI install 可能留下的额外 backup 目录（extensions 内遗留 + 新路径）
            find "$EXTENSIONS_DIR" -maxdepth 1 -name ".openclaw-qqbot-backup-*" -exec rm -rf {} + 2>/dev/null || true
            find "${EXTENSIONS_DIR:-/dev/null}" -maxdepth 1 -name ".openclaw-install-stage-*" -exec rm -rf {} + 2>/dev/null || true
            find "${TMPDIR:-/tmp}" -maxdepth 1 -name ".openclaw-install-stage-*" -exec rm -rf {} + 2>/dev/null || true
            find "${TMPDIR:-/tmp}" -maxdepth 1 -name ".qqbot-upgrade-backup-*" -exec rm -rf {} + 2>/dev/null || true
        else
            echo "  ❌ install 命令返回成功但插件目录不完整"
            echo "  [诊断] 目录存在: $([ -d "$EXTENSIONS_DIR/$PLUGIN_ID" ] && echo '是' || echo '否')"
            echo "  [诊断] package.json 存在: $([ -f "$EXTENSIONS_DIR/$PLUGIN_ID/package.json" ] && echo '是' || echo '否')"
            # 清理可能残留的暂存目录（extensions 和 /tmp 中都可能存在）
            find "${EXTENSIONS_DIR:-/dev/null}" -maxdepth 1 -name ".openclaw-install-stage-*" -exec rm -rf {} + 2>/dev/null || true
            find "${TMPDIR:-/tmp}" -maxdepth 1 -name ".openclaw-install-stage-*" -exec rm -rf {} + 2>/dev/null || true
            # 回滚
            if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
                rm -rf "$EXTENSIONS_DIR/$PLUGIN_ID" 2>/dev/null || true
                # 备份目录内可能是 PLUGIN_ID 子目录或直接是内容
                if [ -d "$BACKUP_DIR/$PLUGIN_ID" ]; then
                    mv "$BACKUP_DIR/$PLUGIN_ID" "$EXTENSIONS_DIR/$PLUGIN_ID"
                else
                    mv "$BACKUP_DIR" "$EXTENSIONS_DIR/$PLUGIN_ID"
                fi
                echo "  ↩️  已回滚到旧版本"
            fi
            restore_qqbot_channel
            echo "QQBOT_NEW_VERSION=unknown"
            echo "QQBOT_REPORT=❌ QQBot 安装异常（目录不完整，已回滚），请重试或手动安装"
            exit 1
        fi
    else
        echo "  ❌ install 失败"
        # 清理可能残留的暂存目录（extensions 和 /tmp 中都可能存在）
        find "${EXTENSIONS_DIR:-/dev/null}" -maxdepth 1 -name ".openclaw-install-stage-*" -exec rm -rf {} + 2>/dev/null || true
        find "${TMPDIR:-/tmp}" -maxdepth 1 -name ".openclaw-install-stage-*" -exec rm -rf {} + 2>/dev/null || true
        # 回滚：恢复旧目录
        if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
            rm -rf "$EXTENSIONS_DIR/$PLUGIN_ID" 2>/dev/null || true
            if [ -d "$BACKUP_DIR/$PLUGIN_ID" ]; then
                mv "$BACKUP_DIR/$PLUGIN_ID" "$EXTENSIONS_DIR/$PLUGIN_ID"
            else
                mv "$BACKUP_DIR" "$EXTENSIONS_DIR/$PLUGIN_ID"
            fi
            echo "  ↩️  已回滚到旧版本"
        fi
        restore_qqbot_channel
        echo "QQBOT_NEW_VERSION=unknown"
        echo "QQBOT_REPORT=❌ QQBot 安装失败（已回滚到旧版本），请检查网络和 npm registry"
        exit 1
    fi
fi

# install/update 完成，恢复 channels.qqbot
restore_qqbot_channel

# [2/4] 验证安装
echo ""
echo "[2/4] 验证安装..."

PKG_JSON="$EXTENSIONS_DIR/$PLUGIN_ID/package.json"
if [ -f "$PKG_JSON" ]; then
  NEW_VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version||'')" "$PKG_JSON" 2>/dev/null || true)"
fi

# Preflight 检查
PREFLIGHT_OK=true
TARGET_DIR="$EXTENSIONS_DIR/$PLUGIN_ID"

if [ -z "$NEW_VERSION" ]; then
    echo "  ❌ 无法读取新版本号"
    PREFLIGHT_OK=false
else
    echo "  ✅ 版本号: $NEW_VERSION"
fi

# 入口文件
ENTRY_FILE=""
for candidate in "dist/index.js" "index.js"; do
    if [ -f "$TARGET_DIR/$candidate" ]; then
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
if [ -d "$TARGET_DIR/dist/src" ]; then
    CORE_JS_COUNT=$(find "$TARGET_DIR/dist/src" -name "*.js" -type f 2>/dev/null | wc -l | tr -d ' ')
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
    if [ ! -f "$TARGET_DIR/$module" ]; then
        MISSING_MODULES="$MISSING_MODULES $module"
    fi
done
if [ -n "$MISSING_MODULES" ]; then
    echo "  ❌ 缺少关键模块:$MISSING_MODULES"
    PREFLIGHT_OK=false
else
    echo "  ✅ 关键模块完整"
fi

# bundled 依赖
if [ -d "$TARGET_DIR/node_modules" ]; then
    BUNDLED_OK=true
    for dep in "ws" "silk-wasm"; do
        if [ ! -d "$TARGET_DIR/node_modules/$dep" ]; then
            echo "  ⚠️  bundled 依赖缺失: $dep"
            BUNDLED_OK=false
        fi
    done
    if $BUNDLED_OK; then
        echo "  ✅ 核心 bundled 依赖完整"
    fi
fi

if [ "$PREFLIGHT_OK" != "true" ]; then
    echo ""
    echo "❌ 验证未通过"
    echo "QQBOT_NEW_VERSION=unknown"
    echo "QQBOT_REPORT=⚠️ QQBot 升级异常，验证未通过"
    exit 1
fi
echo "  ✅ 验证全部通过"

# 确保 openclaw/plugin-sdk 可解析：
# openclaw plugins install 不会执行 npm lifecycle scripts，
# 需要手动调用 postinstall-link-sdk.js 创建 node_modules/openclaw → 全局 openclaw 的符号链接
POSTINSTALL_SCRIPT="$TARGET_DIR/scripts/postinstall-link-sdk.js"
if [ -f "$POSTINSTALL_SCRIPT" ]; then
    echo "  执行 postinstall-link-sdk..."
    if node "$POSTINSTALL_SCRIPT" 2>&1; then
        echo "  ✅ plugin-sdk 链接就绪"
    else
        echo "  ⚠️  postinstall-link-sdk 失败，插件可能无法加载"
    fi
fi

# [3/4] 输出结构化信息（供 TS handler 解析）
echo ""
echo "[3/4] 升级结果..."
echo "QQBOT_NEW_VERSION=${NEW_VERSION:-unknown}"

if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" != "unknown" ]; then
    echo "QQBOT_REPORT=✅ QQBot 升级完成: v${NEW_VERSION}"
else
    echo "QQBOT_REPORT=⚠️ QQBot 升级异常，无法确认新版本"
fi

echo ""
echo "==========================================="
echo "  ✅ 安装完成"
echo "==========================================="

# --no-restart 模式（热更新场景）：立即退出，让调用方触发 gateway restart
if [ "$NO_RESTART" = "true" ]; then
    echo ""
    echo "[跳过重启] --no-restart 已指定，脚本立即退出以便调用方触发 gateway restart"
    exit 0
fi

# 以下步骤仅在非热更新（手动执行）场景中执行

# [配置] appid/secret（仅在提供了参数时执行）
if [ -n "$APPID" ] && [ -n "$SECRET" ]; then
    echo ""
    echo "[配置] 写入 qqbot 通道配置..."
    DESIRED_TOKEN="${APPID}:${SECRET}"

    # 读取当前已有的 token
    CURRENT_TOKEN=""
    for _app in openclaw clawdbot moltbot; do
        _cfg="$HOME/.$_app/$_app.json"
        if [ -f "$_cfg" ]; then
            CURRENT_TOKEN=$(node -e "
                const cfg = JSON.parse(require('fs').readFileSync('$_cfg', 'utf8'));
                const keys = ['qqbot', 'openclaw-qqbot', 'openclaw-qq'];
                for (const key of keys) {
                    const ch = cfg.channels && cfg.channels[key];
                    if (!ch) continue;
                    if (ch.token) { process.stdout.write(ch.token); process.exit(0); }
                    if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId + ':' + ch.clientSecret); process.exit(0); }
                }
            " 2>/dev/null || true)
            [ -n "$CURRENT_TOKEN" ] && break
        fi
    done

    if [ "$CURRENT_TOKEN" = "$DESIRED_TOKEN" ]; then
        echo "  ✅ 当前配置已是目标值，跳过写入"
    else
        # qqbot 是插件自定义通道，openclaw channels add --channel 不支持，
        # 直接编辑配置文件写入 channels.qqbot
        CONFIG_FILE="$HOME/.$CMD/$CMD.json"
        if [ -f "$CONFIG_FILE" ] && node -e "
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
            if (!cfg.channels) cfg.channels = {};
            if (!cfg.channels.qqbot) cfg.channels.qqbot = {};
            cfg.channels.qqbot.appId = '$APPID';
            cfg.channels.qqbot.clientSecret = '$SECRET';
            fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 4) + '\n');
        " 2>&1; then
            echo "  ✅ 通道配置写入成功"
        else
            echo "  ❌ 配置写入失败，请手动编辑 $CONFIG_FILE 添加 channels.qqbot:"
            echo "     { \"channels\": { \"qqbot\": { \"appId\": \"$APPID\", \"clientSecret\": \"...\" } } }"
        fi
    fi
elif [ -n "$APPID" ] || [ -n "$SECRET" ]; then
    echo ""
    echo "⚠️  --appid 和 --secret 必须同时提供"
fi

# [4/4] 重启 gateway 使新版本生效
echo ""

# 手动升级场景：提前写入 startup-marker，阻止重启后 bot 重复推送升级通知
if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" != "unknown" ]; then
    MARKER_DIR="$HOME/.openclaw/qqbot/data"
    mkdir -p "$MARKER_DIR"
    MARKER_FILE="$MARKER_DIR/startup-marker.json"
    NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date +%Y-%m-%dT%H:%M:%SZ)"
    echo "{\"version\":\"$NEW_VERSION\",\"startedAt\":\"$NOW\",\"greetedAt\":\"$NOW\"}" > "$MARKER_FILE"
fi

echo "[重启] 重启 gateway 使新版本生效..."
if $CMD gateway restart 2>&1; then
    echo "  ✅ gateway 已重启"
    echo ""
    if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" != "unknown" ]; then
        echo "🎉 QQBot 插件已更新至 v${NEW_VERSION}，在线等候你的吩咐。"
    fi
else
    echo "  ⚠️  gateway 重启失败，请手动执行: $CMD gateway restart"
fi
