#!/bin/bash
# QQBot 插件升级脚本
# 用于清理旧版本插件并重新安装
# 兼容 clawdbot 和 openclaw 两种安装

set -e

echo "=== QQBot 插件升级脚本 ==="

# 检测使用的是 clawdbot 还是 openclaw
detect_installation() {
  if [ -d "$HOME/.clawdbot" ]; then
    echo "clawdbot"
  elif [ -d "$HOME/.openclaw" ]; then
    echo "openclaw"
  else
    echo ""
  fi
}

# 清理指定目录的函数
cleanup_installation() {
  local APP_NAME="$1"
  local APP_DIR="$HOME/.$APP_NAME"
  local CONFIG_FILE="$APP_DIR/$APP_NAME.json"
  local EXTENSION_DIR="$APP_DIR/extensions/qqbot"

  echo ""
  echo ">>> 处理 $APP_NAME 安装..."

  # 1. 删除旧的扩展目录
  if [ -d "$EXTENSION_DIR" ]; then
    echo "删除旧版本插件: $EXTENSION_DIR"
    rm -rf "$EXTENSION_DIR"
  else
    echo "未找到旧版本插件目录，跳过删除"
  fi

  # 2. 清理配置文件中的 qqbot 相关字段
  if [ -f "$CONFIG_FILE" ]; then
    echo "清理配置文件中的 qqbot 字段..."
    
    # 使用 node 处理 JSON（比 jq 更可靠处理复杂结构）
    node -e "
      const fs = require('fs');
      const config = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
      
      // 删除 channels.qqbot
      if (config.channels && config.channels.qqbot) {
        delete config.channels.qqbot;
        console.log('  - 已删除 channels.qqbot');
      }
      
      // 删除 plugins.entries.qqbot
      if (config.plugins && config.plugins.entries && config.plugins.entries.qqbot) {
        delete config.plugins.entries.qqbot;
        console.log('  - 已删除 plugins.entries.qqbot');
      }
      
      // 删除 plugins.installs.qqbot
      if (config.plugins && config.plugins.installs && config.plugins.installs.qqbot) {
        delete config.plugins.installs.qqbot;
        console.log('  - 已删除 plugins.installs.qqbot');
      }
      
      fs.writeFileSync('$CONFIG_FILE', JSON.stringify(config, null, 2));
      console.log('配置文件已更新');
    "
  else
    echo "未找到配置文件: $CONFIG_FILE"
  fi
}

# 检测并处理所有可能的安装
FOUND_INSTALLATION=""

# 检查 clawdbot
if [ -d "$HOME/.clawdbot" ]; then
  cleanup_installation "clawdbot"
  FOUND_INSTALLATION="clawdbot"
fi

# 检查 openclaw
if [ -d "$HOME/.openclaw" ]; then
  cleanup_installation "openclaw"
  FOUND_INSTALLATION="openclaw"
fi

# 如果都没找到
if [ -z "$FOUND_INSTALLATION" ]; then
  echo "未找到 clawdbot 或 openclaw 安装目录"
  echo "请确认已安装 clawdbot 或 openclaw"
  exit 1
fi

# 使用检测到的安装类型作为命令
CMD="$FOUND_INSTALLATION"

echo ""
echo "=== 清理完成 ==="
echo ""
echo "接下来请执行以下命令重新安装插件:"
echo "  cd /path/to/qqbot"
echo "  $CMD plugins install ."
echo "  $CMD channels add --channel qqbot --token \"AppID:AppSecret\""
echo "  $CMD gateway restart"
