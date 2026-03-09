#!/bin/bash

# QQBot 一键更新并启动脚本
# 版本: 2.0 (增强错误处理版)
#
# 主要改进:
# 1. 详细的安装错误诊断和排查建议
# 2. 所有关键步骤的错误捕获和报告
# 3. 日志文件保存和错误摘要
# 4. 智能故障排查指南
# 5. 用户友好的交互提示

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 如果脚本在 scripts/ 子目录里，往上一级就是项目根目录
if [ "$(basename "$SCRIPT_DIR")" = "scripts" ]; then
    PROJ_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    PROJ_DIR="$SCRIPT_DIR"
fi
cd "$PROJ_DIR"

# 解析命令行参数
APPID=""
SECRET=""
MARKDOWN=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --appid)
            APPID="$2"
            shift 2
            ;;
        --secret)
            SECRET="$2"
            shift 2
            ;;
        --markdown)
            MARKDOWN="$2"
            shift 2
            ;;
        -h|--help)
            echo "用法: $0 [选项]"
            echo ""
            echo "选项:"
            echo "  --appid <appid>       QQ机器人 AppID"
            echo "  --secret <secret>     QQ机器人 Secret"
            echo "  --markdown <yes|no>   是否启用 Markdown 消息格式（默认: no）"
            echo "  -h, --help            显示帮助信息"
            echo ""
            echo "也可以通过环境变量设置:"
            echo "  QQBOT_APPID           QQ机器人 AppID"
            echo "  QQBOT_SECRET          QQ机器人 Secret"
            echo "  QQBOT_TOKEN           QQ机器人 Token (AppID:Secret)"
            echo "  QQBOT_MARKDOWN        是否启用 Markdown（yes/no）"
            echo ""
            echo "不带参数时，将使用已有配置直接启动。"
            echo ""
            echo "⚠️  注意: 启用 Markdown 需要在 QQ 开放平台申请 Markdown 消息权限"
            exit 0
            ;;
        *)
            echo "未知选项: $1"
            echo "使用 --help 查看帮助信息"
            exit 1
            ;;
    esac
done

# 使用命令行参数或环境变量
APPID="${APPID:-$QQBOT_APPID}"
SECRET="${SECRET:-$QQBOT_SECRET}"
MARKDOWN="${MARKDOWN:-$QQBOT_MARKDOWN}"

echo "========================================="
echo "  QQBot 一键更新启动脚本"
echo "========================================="

# 1. 备份已有 qqbot 通道配置，防止升级过程丢失
echo ""
echo "[1/6] 备份已有配置..."
SAVED_QQBOT_TOKEN=""
for APP_NAME in openclaw clawdbot moltbot; do
    CONFIG_FILE="$HOME/.$APP_NAME/$APP_NAME.json"
    if [ -f "$CONFIG_FILE" ]; then
        SAVED_QQBOT_TOKEN=$(node -e "
            const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE', 'utf8'));
            // 尝试所有可能的 channel key（原仓库 + 本仓库）
            const keys = ['qqbot', 'openclaw-qq'];
            for (const key of keys) {
                const ch = cfg.channels && cfg.channels[key];
                if (!ch) continue;
                if (ch.token) { process.stdout.write(ch.token); process.exit(0); }
                if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId + ':' + ch.clientSecret); process.exit(0); }
            }
        " 2>/dev/null || true)
        if [ -n "$SAVED_QQBOT_TOKEN" ]; then
            echo "已备份 qqbot 通道 token: ${SAVED_QQBOT_TOKEN:0:10}..."
            break
        fi
    fi
done

# 2. 移除老版本
echo ""
echo "[2/6] 移除老版本..."
if [ -f "$PROJ_DIR/scripts/upgrade.sh" ]; then
    bash "$PROJ_DIR/scripts/upgrade.sh"
else
    echo "警告: upgrade.sh 不存在，跳过移除步骤"
fi

# 3. 安装当前版本
echo ""
echo "[3/6] 安装当前版本..."

echo "检查当前目录: $(pwd)"
echo "检查openclaw版本: $(openclaw --version 2>/dev/null || echo 'openclaw not found')"

# 记录更新前的 qqbot 插件版本
OLD_QQBOT_VERSION=$(node -e '
    try {
        var p = require(process.env.HOME + "/.openclaw/extensions/qqbot/package.json");
        process.stdout.write(p.version || "unknown");
    } catch(e) { process.stdout.write("not_installed"); }
' 2>/dev/null || echo "not_installed")

echo "开始安装插件..."
INSTALL_LOG="/tmp/openclaw-install-$(date +%s).log"

echo "安装日志文件: $INSTALL_LOG"
echo "详细信息将记录到日志文件中..."

# 尝试安装并捕获详细输出
if ! openclaw plugins install . 2>&1 | tee "$INSTALL_LOG"; then
    echo ""
    echo "❌ 插件安装失败！"
    echo "========================================="
    echo "故障排查信息:"
    echo "========================================="
    
    # 分析错误原因
    echo "1. 检查日志文件末尾: $INSTALL_LOG"
    echo "2. 常见原因分析:"
    
    # 检查网络连接
    echo "   - 网络问题: 测试 npm 仓库连接"
    echo "     curl -I https://registry.npmjs.org/ || curl -I https://registry.npmmirror.com/"
    
    # 检查权限
    echo "   - 权限问题: 检查安装目录权限"
    echo "     ls -la ~/.openclaw/ 2>/dev/null || echo '目录不存在'"
    
    # 检查npm配置
    echo "   - npm配置: 检查当前npm配置"
    echo "     npm config get registry"
    
    # 显示错误摘要
    echo ""
    echo "3. 错误摘要:"
    tail -20 "$INSTALL_LOG" | grep -i -E "(error|fail|warn|npm install)"
    
    echo ""
    echo "4. 可选解决方案:"
    echo "   a. 更换npm镜像源:"
    echo "      npm config set registry https://registry.npmmirror.com/"
    echo "   b. 清理npm缓存:"
    echo "      npm cache clean --force"
    echo "   c. 手动安装依赖:"
    echo "      cd $(pwd) && npm install --verbose"
    
    echo ""
    echo "========================================="
    echo "建议: 先查看完整日志文件: cat $INSTALL_LOG"
    echo "或者尝试手动安装: cd $(pwd) && npm install"
    echo "========================================="
    
    read -t 10 -p "是否继续配置其他步骤? (y/N): " continue_choice || continue_choice="N"
    case "$continue_choice" in
        [Yy]* )
            echo "继续执行后续配置步骤..."
            ;;  
        * )
            echo "安装失败，脚本退出。"
            echo "请先解决安装问题后再运行此脚本。"
            exit 1
            ;;  
    esac
else
    echo ""
    echo "✅ 插件安装成功！"
    echo "安装日志已保存到: $INSTALL_LOG"

    # 记录更新后的 qqbot 插件版本
    NEW_QQBOT_VERSION=$(node -e '
        try {
            var p = require(process.env.HOME + "/.openclaw/extensions/qqbot/package.json");
            process.stdout.write(p.version || "unknown");
        } catch(e) { process.stdout.write("unknown"); }
    ' 2>/dev/null || echo "unknown")
fi

# 4. 配置机器人通道（仅在提供了 appid/secret 时才配置，否则使用已有配置）
echo ""
echo "[4/6] 配置机器人通道..."

if [ -n "$APPID" ] && [ -n "$SECRET" ]; then
    QQBOT_TOKEN="${APPID}:${SECRET}"
    echo "使用提供的 AppID 和 Secret 配置..."
    echo "配置机器人通道: qqbot"
    echo "使用Token: ${QQBOT_TOKEN:0:10}..."

    if ! openclaw channels add --channel qqbot --token "$QQBOT_TOKEN" 2>&1; then
        echo ""
        echo "⚠️  警告: 机器人通道配置失败，但脚本将继续执行"
        echo "可能的原因:"
        echo "1. Token格式错误 (应为 AppID:Secret)"
        echo "2. OpenClaw未正确安装"
        echo "3. qqbot通道已存在"
        echo ""
        echo "您可以稍后手动配置: openclaw channels add --channel qqbot --token 'AppID:Secret'"
    else
        echo "✅ 机器人通道配置成功"
    fi
elif [ -n "$QQBOT_TOKEN" ]; then
    echo "使用环境变量 QQBOT_TOKEN 配置..."
    echo "使用Token: ${QQBOT_TOKEN:0:10}..."

    if ! openclaw channels add --channel qqbot --token "$QQBOT_TOKEN" 2>&1; then
        echo "⚠️  警告: 机器人通道配置失败，继续使用已有配置"
    else
        echo "✅ 机器人通道配置成功"
    fi
else
    # 未传参数，尝试用备份的 token 恢复通道配置
    if [ -n "$SAVED_QQBOT_TOKEN" ]; then
        echo "未提供 AppID/Secret，使用备份的 token 恢复配置..."
        if ! openclaw channels add --channel qqbot --token "$SAVED_QQBOT_TOKEN" 2>&1; then
            echo "⚠️  警告: 恢复通道配置失败，可能通道已存在"
        else
            echo "✅ 已从备份恢复 qqbot 通道配置"
        fi
    else
        # 检测是否存在已有的 qqbot 通道配置
        _has_channel=0
        for _app in openclaw clawdbot moltbot; do
            _cfg="$HOME/.$_app/$_app.json"
            if [ -f "$_cfg" ]; then
                _tok=$(node -e "
                    const cfg=JSON.parse(require('fs').readFileSync('$_cfg','utf8'));
                    const ch=cfg.channels&&cfg.channels.qqbot;
                    if(ch&&(ch.token||(ch.appId&&ch.clientSecret)))process.stdout.write('1');
                " 2>/dev/null || true)
                if [ "$_tok" = "1" ]; then _has_channel=1; break; fi
            fi
        done

        if [ "$_has_channel" -eq 0 ]; then
            echo ""
            echo "❌ 未检测到 qqbot 通道配置！"
            echo ""
            echo "首次运行请提供 AppID 和 AppSecret："
            echo ""
            echo "  bash $0 --appid <你的AppID> --secret <你的AppSecret>"
            echo ""
            echo "也可以通过环境变量："
            echo ""
            echo "  QQBOT_APPID=<AppID> QQBOT_SECRET=<AppSecret> bash $0"
            echo ""
            echo "AppID 和 AppSecret 可在 QQ 开放平台 (https://q.qq.com) 获取。"
            exit 1
        else
            echo "使用已有配置"
        fi
    fi
fi

# 5. 配置 Markdown 选项（仅在明确指定时才配置）
echo ""
echo "[5/6] 配置 Markdown 选项..."

if [ -n "$MARKDOWN" ]; then
    # 设置 markdown 配置
    if [ "$MARKDOWN" = "yes" ] || [ "$MARKDOWN" = "y" ] || [ "$MARKDOWN" = "true" ]; then
        MARKDOWN_VALUE="true"
        echo "启用 Markdown 消息格式..."
    else
        MARKDOWN_VALUE="false"
        echo "禁用 Markdown 消息格式（使用纯文本）..."
    fi

    # 优先使用 openclaw config set，失败时回退到直接编辑 JSON
    if openclaw config set channels.qqbot.markdownSupport "$MARKDOWN_VALUE" 2>&1; then
        echo "✅ Markdown配置成功"
    else
        echo "⚠️  openclaw config set 失败，尝试直接编辑配置文件..."
        OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
        if [ -f "$OPENCLAW_CONFIG" ] && node -e "
          const fs = require('fs');
          const cfg = JSON.parse(fs.readFileSync('$OPENCLAW_CONFIG', 'utf-8'));
          if (!cfg.channels) cfg.channels = {};
          if (!cfg.channels.qqbot) cfg.channels.qqbot = {};
          cfg.channels.qqbot.markdownSupport = $MARKDOWN_VALUE;
          fs.writeFileSync('$OPENCLAW_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
        " 2>&1; then
            echo "✅ Markdown配置成功（直接编辑配置文件）"
        else
            echo "⚠️  Markdown配置设置失败，不影响后续运行"
        fi
    fi
else
    echo "未指定 Markdown 选项，使用已有配置"
fi

# 6. 启动 openclaw
echo ""
echo "[6/6] 启动 openclaw..."
echo "========================================="

# 检查openclaw是否可用
if ! command -v openclaw &> /dev/null; then
    echo "❌ 错误: openclaw 命令未找到！"
    echo ""
    echo "可能的原因:"
    echo "1. OpenClaw未安装或安装失败"
    echo "2. PATH环境变量未包含openclaw路径"
    echo "3. 需要重新登录或重启终端"
    echo ""
    exit 1
fi

echo "OpenClaw版本: $(openclaw --version 2>/dev/null || echo '未知')"

# 显示 qqbot 插件更新信息
NEW_QQBOT_VERSION="${NEW_QQBOT_VERSION:-unknown}"
if [ "$OLD_QQBOT_VERSION" = "$NEW_QQBOT_VERSION" ]; then
    echo "QQBot 插件版本: $NEW_QQBOT_VERSION (未变化)"
elif [ "$OLD_QQBOT_VERSION" = "not_installed" ]; then
    echo "QQBot 插件版本: $NEW_QQBOT_VERSION (新安装)"
else
    echo "QQBot 插件版本: $OLD_QQBOT_VERSION -> $NEW_QQBOT_VERSION"
fi
echo ""
echo "请选择启动方式:"
echo ""
echo "  1) 后台重启 (推荐)"
echo "     重启后台服务，自动跟踪日志输出"
echo ""
echo "  2) 不启动"
echo "     插件已更新完毕，稍后自己手动启动"
echo ""
read -t 30 -p "请输入选择 [1/2] (默认 1): " start_choice || start_choice="1"
start_choice="${start_choice:-1}"

case "$start_choice" in
    1)
        echo ""
        echo "正在后台重启 OpenClaw 网关服务..."
        if openclaw gateway restart 2>&1; then
            echo ""
            echo "✅ OpenClaw 网关已在后台重启"
            echo ""
            # 等待 gateway 端口就绪（插件安装+自动重启可能需要 30-60 秒）
            echo "等待 gateway 就绪（插件安装中，可能需要 30-60 秒）..."
            echo "========================================="
            _port_ready=0
            for i in $(seq 1 30); do
                if lsof -i :18789 -sTCP:LISTEN >/dev/null 2>&1; then
                    _port_ready=1
                    break
                fi
                printf "\r  等待端口 18789 就绪... (%d/30)" "$i"
                sleep 2
            done
            echo ""

            if [ "$_port_ready" -eq 0 ]; then
                echo "⚠️  等待超时，gateway 可能仍在启动中"
                echo "请手动检查: openclaw doctor"
                echo "或查看日志: tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
            else
                echo "✅ Gateway 端口已就绪"
                echo ""
                # 额外等待几秒，让插件重启循环稳定
                echo "等待插件加载稳定..."
                sleep 8
                echo ""
                echo "正在跟踪日志输出（按 Ctrl+C 停止查看，不影响后台服务）..."
                echo "========================================="
                _retries=0
                while ! openclaw logs --follow 2>&1; do
                    _retries=$((_retries + 1))
                    if [ $_retries -ge 5 ]; then
                        echo ""
                        echo "⚠️  无法连接日志流，请手动执行: openclaw logs --follow"
                        echo "或直接查看日志文件: tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
                        break
                    fi
                    echo "等待日志流就绪... (${_retries}/5)"
                    sleep 3
                done
            fi
        else
            echo ""
            echo "⚠️  后台重启失败，可能服务未安装"
            echo "尝试: openclaw gateway install && openclaw gateway start"
        fi
        ;;
    2)
        echo ""
        echo "✅ 插件更新完毕，未启动服务"
        echo ""
        echo "后续可手动启动:"
        echo "  openclaw gateway restart    # 重启后台服务"
        echo "  openclaw logs --follow      # 跟踪日志"
        ;;
    *)
        echo "无效选择，跳过启动"
        ;;
esac

echo "========================================="
