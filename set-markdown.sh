#!/bin/bash

# QQBot Markdown 配置脚本
# 用于单独设置是否启用 Markdown 消息格式
# 直接编辑 JSON 配置文件，避免框架验证拒绝未注册的 channel

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"

show_help() {
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  enable, on, yes      启用 Markdown 消息格式"
    echo "  disable, off, no     禁用 Markdown 消息格式（使用纯文本）"
    echo "  status               显示当前 Markdown 配置状态"
    echo "  -h, --help           显示帮助信息"
    echo ""
    echo "示例:"
    echo "  $0 enable            启用 Markdown"
    echo "  $0 disable           禁用 Markdown"
    echo "  $0 status            查看当前状态"
    echo "  $0                   交互式选择"
    echo ""
    echo "⚠️  注意: 启用 Markdown 需要在 QQ 开放平台申请 Markdown 消息权限"
    echo "         如果没有权限，消息将无法正常发送！"
}

set_markdown_value() {
    local value="$1"
    if [ ! -f "$OPENCLAW_CONFIG" ]; then
        echo "  错误: 配置文件不存在: $OPENCLAW_CONFIG"
        echo "  请先运行 openclaw onboard 初始化配置"
        exit 1
    fi
    node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$OPENCLAW_CONFIG', 'utf-8'));
      if (!cfg.channels) cfg.channels = {};
      if (!cfg.channels.qqbot) cfg.channels.qqbot = {};
      cfg.channels.qqbot.markdownSupport = $value;
      fs.writeFileSync('$OPENCLAW_CONFIG', JSON.stringify(cfg, null, 4) + '\n');
    "
}

enable_markdown() {
    echo "✅ 启用 Markdown 消息格式..."
    set_markdown_value true
    echo ""
    echo "Markdown 已启用。"
    echo "⚠️  请确保您已在 QQ 开放平台申请了 Markdown 消息权限。"
}

disable_markdown() {
    echo "❌ 禁用 Markdown 消息格式（使用纯文本）..."
    set_markdown_value false
    echo ""
    echo "Markdown 已禁用，将使用纯文本格式发送消息。"
}

show_status() {
    echo "当前 Markdown 配置状态:"
    echo ""
    if [ -f "$OPENCLAW_CONFIG" ]; then
        current=$(node -e "
          const cfg = JSON.parse(require('fs').readFileSync('$OPENCLAW_CONFIG', 'utf-8'));
          console.log(cfg.channels?.qqbot?.markdownSupport ?? '未设置');
        " 2>/dev/null || echo "未设置")
        if [ "$current" = "true" ]; then
            echo "  状态: ✅ 已启用"
            echo ""
            echo "  ⚠️  请确保您已在 QQ 开放平台申请了 Markdown 消息权限。"
        elif [ "$current" = "false" ]; then
            echo "  状态: ❌ 已禁用（纯文本模式）"
        else
            echo "  状态: 未设置（默认: 禁用）"
        fi
    else
        echo "  错误: 配置文件不存在: $OPENCLAW_CONFIG"
        exit 1
    fi
}

interactive_select() {
    echo "========================================="
    echo "  QQBot Markdown 配置"
    echo "========================================="
    echo ""
    show_status
    echo ""
    echo "-----------------------------------------"
    echo ""
    echo "是否启用 Markdown 消息格式？"
    echo ""
    echo "⚠️  注意: 启用 Markdown 需要在 QQ 开放平台申请 Markdown 消息权限"
    echo "         如果没有权限，消息将无法正常发送！"
    echo ""
    echo "  1) 启用 Markdown"
    echo "  2) 禁用 Markdown（纯文本）"
    echo "  3) 取消"
    echo ""
    read -p "请选择 [1-3] (默认: 2): " choice
    
    case "$choice" in
        1)
            echo ""
            enable_markdown
            ;;
        2|"")
            echo ""
            disable_markdown
            ;;
        3)
            echo "已取消。"
            exit 0
            ;;
        *)
            echo "无效选择，已取消。"
            exit 1
            ;;
    esac
}

# 主逻辑
case "${1:-}" in
    enable|on|yes)
        enable_markdown
        ;;
    disable|off|no)
        disable_markdown
        ;;
    status)
        show_status
        ;;
    -h|--help)
        show_help
        ;;
    "")
        interactive_select
        ;;
    *)
        echo "未知选项: $1"
        echo ""
        show_help
        exit 1
        ;;
esac
