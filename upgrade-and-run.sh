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

set -e

# 检查是否使用 sudo 运行（不建议）
if [ "$EUID" -eq 0 ]; then
    echo "⚠️  警告: 请不要使用 sudo 运行此脚本！"
    echo "   使用 sudo 会导致配置文件权限问题。"
    echo ""
    echo "请直接运行:"
    echo "   ./upgrade-and-run.sh"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

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
            echo "  QQBOT_MARKDOWN        是否启用 Markdown（yes/no）"
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

# 1. 移除老版本
echo ""
echo "[1/4] 移除老版本..."
if [ -f "./scripts/upgrade.sh" ]; then
    bash ./scripts/upgrade.sh
else
    echo "警告: upgrade.sh 不存在，跳过移除步骤"
fi

# 2. 安装当前版本
echo ""
echo "[2/4] 安装当前版本..."

echo "检查当前目录: $(pwd)"
echo "检查openclaw版本: $(openclaw --version 2>/dev/null || echo 'openclaw not found')"

echo "开始安装插件..."
INSTALL_LOG="/tmp/openclaw-install-\$(date +%s).log"

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
    
    read -p "是否继续配置其他步骤? (y/N): " continue_choice
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
fi

# 3. 配置机器人通道
echo ""
echo "[3/4] 配置机器人通道..."

# 构建 token（如果提供了 appid 和 secret）
if [ -n "$APPID" ] && [ -n "$SECRET" ]; then
    QQBOT_TOKEN="${APPID}:${SECRET}"
    echo "使用提供的 AppID 和 Secret 配置..."
else
    # 默认 token，可通过环境变量 QQBOT_TOKEN 覆盖
    QQBOT_TOKEN="${QQBOT_TOKEN:-appid:secret}"
    echo "使用默认或环境变量中的 Token..."
fi

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

# 5. 配置 Markdown 选项
echo ""
echo "[4/4] 配置 Markdown 选项..."

# 如果没有通过参数或环境变量指定，询问用户
if [ -z "$MARKDOWN" ]; then
    echo ""
    echo "是否启用 Markdown 消息格式？"
    echo "⚠️  注意: 启用 Markdown 需要在 QQ 开放平台申请 Markdown 消息权限"
    echo "         如果没有权限，消息将无法正常发送！"
    echo ""
    read -p "启用 Markdown? (y/N): " md_choice
    case "$md_choice" in
        [Yy]* )
            MARKDOWN="yes"
            ;;
        * )
            MARKDOWN="no"
            ;;
    esac
fi

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

# 6. 启动 openclaw
echo ""
echo "[5/5] 启动 openclaw..."
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
    echo "解决方案:"
    echo "1. 检查OpenClaw安装: which openclaw 或 find / -name openclaw 2>/dev/null"
    echo "2. 手动启动: 进入OpenClaw安装目录执行"
    echo "3. 添加PATH: export PATH=\"\$PATH:/path/to/openclaw\""
    echo ""
    exit 1
fi

# 显示启动信息
echo "启动命令: openclaw gateway --verbose"
echo "OpenClaw版本: $(openclaw --version 2>/dev/null || echo '未知')"
echo "当前目录: $(pwd)"
echo ""
echo "如果启动失败，请检查:"
echo "1. 端口占用: lsof -i :3000 (或OpenClaw使用的端口)"
echo "2. 配置文件: ls -la ~/.openclaw/"

echo "3. 查看日志: tail -f ~/.openclaw/logs/*.log 2>/dev/null || echo '无日志文件'"
echo ""
echo "按 Ctrl+C 停止服务"
echo "========================================="

echo "正在启动 OpenClaw 网关服务..."
START_TIME=$(date +%s)

# 启动服务并捕获输出
GATEWAY_LOG="/tmp/openclaw-gateway-$(date +%s).log"
echo "网关日志: $GATEWAY_LOG"

set +e  # 临时禁用严格错误检查，让用户可以Ctrl+C停止
openclaw gateway --verbose 2>&1 | grep --line-buffered -v '\[ws\] → event \(health\|tick\)' | tee "$GATEWAY_LOG"
EXIT_CODE=$?
set -e  # 重新启用严格错误检查

END_TIME=$(date +%s)
RUNTIME=$((END_TIME - START_TIME))

echo ""
echo "========================================="
echo "服务运行了 ${RUNTIME} 秒后退出，退出代码: $EXIT_CODE"

if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ OpenClaw 正常退出"
elif [ $EXIT_CODE -eq 130 ]; then
    echo "⚠️  OpenClaw 被用户中断 (Ctrl+C)"
else
    echo "❌ OpenClaw 异常退出 (代码: $EXIT_CODE)"
    echo ""
    echo "故障诊断信息:"
    echo "1. 查看完整日志: cat $GATEWAY_LOG"
    echo "2. 常见错误代码:"
    echo "   - 1: 一般错误"
    echo "   - 2: 配置错误"
    echo "   - 3: 端口占用"
    echo "   - 4: 依赖缺失"
    echo ""
    echo "3. 检查步骤:"
    echo "   a. 检查端口: lsof -i :3000 2>/dev/null || echo '端口3000可用'"
    echo "   b. 检查依赖: openclaw --version"
    echo "   c. 检查配置: ls -la ~/.openclaw/config.yaml 2>/dev/null"
    
    # 显示错误摘要
    if [ -f "$GATEWAY_LOG" ]; then
        echo ""
        echo "4. 错误摘要:"
        tail -30 "$GATEWAY_LOG" | grep -i -E "(error|fail|exception|panic|uncaught|syntax)"
    fi
fi

echo "========================================="
