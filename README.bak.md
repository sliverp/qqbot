<div align="center">

# QQ Bot Channel Plugin for Openclaw(Clawdbot/Moltbot)

QQ 开放平台 Bot API 的 Openclaw 渠道插件，支持 C2C 私聊、群聊 @消息、频道消息。

[![npm version](https://img.shields.io/badge/npm-v1.4.1-blue)](https://www.npmjs.com/package/@sliverp/qqbot)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Platform](https://img.shields.io/badge/platform-Openclaw-orange)](https://github.com/sliverp/openclaw)
[![Node.js](https://img.shields.io/badge/Node.js->=18-339933)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6)](https://www.typescriptlang.org/)

</div>


---

## 📸 使用示例
<div align="center">
<img width="400" alt="使用示例" src="https://github.com/user-attachments/assets/6f1704ab-584b-497e-8937-96f84ce2958f" />
<img width="670" height="396" alt="Clipboard_Screenshot_1770366319" src="https://github.com/user-attachments/assets/e21e9292-fb93-41a7-81fe-39eeefe3b01d" />

</div>

---

## ✨ 功能特性

- 🔒 **多场景支持** - C2C 私聊、群聊 @消息、频道消息、频道私信
- 🖼️ **富媒体消息** - 支持图片收发、文件发送
- ⏰ **定时推送** - 支持定时任务到时后主动推送
- 🔗 **URL 无限制** - 私聊可直接发送 URL
- ⌨️ **输入状态** - Bot 正在输入中状态提示
- 🔄 **热更新** - 支持 npm 方式安装和热更新
- 📝 **Markdown** - 支持 Markdown 格式
- 📝 **Command** - 支持Openclaw原生命令

  
---

## ⭐ Star 趋势
<div align="center">
<img width="666" height="464" alt="star-history-202626 (1)" src="https://github.com/user-attachments/assets/01d123b4-f2a7-45b9-b2ed-b7a344497b4a" />



</div>

---

## 📦 安装

### 方式一：腾讯云 Lighthouse 镜像（最简单）

[![Lighthouse](https://img.shields.io/badge/腾讯云-Lighthouse_镜像-00A4FF)](https://cloud.tencent.com/product/lighthouse)

直接使用预装好的腾讯云 Lighthouse 镜像，开箱即用，无需手动安装配置。

### 方式二：npm 安装（推荐）

```bash
openclaw plugins install @sliverp/qqbot@1.3.7
```

### 方式三：源码安装

```bash
git clone https://github.com/sliverp/qqbot.git && cd qqbot
clawdbot plugins install .
```

> 💡 安装过程需要一些时间，尤其是小内存机器，请耐心等待

---

## ⚙️ 配置

### 1. 获取 QQ 机器人凭证

1. 访问 [QQ 开放平台](https://q.qq.com/)
2. 创建机器人应用
3. 获取 `AppID` 和 `AppSecret`（ClientSecret）
4. Token 格式：`AppID:AppSecret`

### 2. 添加配置

**交互式配置：**

```bash
clawdbot channels add
# 选择 qqbot，按提示输入 Token
```

**命令行配置：**

```bash
clawdbot channels add --channel qqbot --token "AppID:AppSecret"
```

### 3. 手动编辑配置（可选）

编辑 `~/.clawdbot/clawdbot.json`：

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "你的AppID",
      "clientSecret": "你的AppSecret"
    }
  }
}
```

---


## 🚀 使用

### 启动服务

```bash
# 后台启动
clawdbot gateway restart

# 前台启动（查看日志）
clawdbot gateway --port 18789 --verbose
```

### CLI 配置向导

```bash
clawdbot onboard
# 选择 QQ Bot 进行交互式配置
```

---

## ⚠️ 注意事项

- **群消息**：需要在群内 @机器人 才能触发回复
- **沙箱模式**：新创建的机器人默认在沙箱模式，需要添加测试用户

---

## 🔄 升级

### npm 热更新

```bash
npx -y @sliverp/qqbot@1.3.7 upgrade
```

> 热更新后无需重新配置 AppId 和 AppSecret。该方式Openclaw和Node.js会占用大量内存，小内存机器优先建议使用源码方式热更新

### 源码热更新

```bash
git clone https://github.com/sliverp/qqbot.git && cd qqbot 

# 运行升级脚本
bash ./scripts/upgrade.sh

# 重新安装
clawdbot plugins install .

# 重新配置
clawdbot channels add --channel qqbot --token "AppID:AppSecret"

# 重启网关
clawdbot gateway restart
```

升级脚本会自动清理旧版本和配置。




---

## 📚 版本历史

<details>
<summary><b>v1.4.0</b></summary>

- 支持 Markdown 格式

</details>

<details>
<summary><b>v1.3.13 - 2026.02.06</b></summary>

- ✨ 支持Openclawd内置指令“/compact" , "/new"等（注意，/reset等命令有危险性，非常不建议把Bot拉入群聊）
- 🐛 修复在一些情况下”正在输入“不生效的问题

</details>

<details>
<summary><b>v1.3.0 - 2026.02.03</b></summary>

- ✨ 支持图片收发等功能
- ✨ 支持定时任务到时后主动推送
- ✨ 支持使用 npm 等方式安装和升级
- 🐛 优化一些已知问题

</details>

<details>
<summary><b>v1.2.5 - 2026.02.02</b></summary>

- ✨ 解除 URL 发送限制
- ✨ 更新 Bot 正在输入中状态
- ✨ 提供主动推送能力
- 🐛 优化一些已知问题

</details>

<details>
<summary><b>v1.2.2 - 2026.01.31</b></summary>

- ✨ 支持发送文件
- ✨ 支持 openclaw、moltbot 命令行
- 🐛 修复 health 检查提示问题
- 🐛 修复文件发送后 clawdbot 无法读取的问题

</details>

<details>
<summary><b>v1.2.1</b></summary>

- 🐛 解决长时间使用会断联的问题
- 🐛 解决频繁重连的问题
- ✨ 增加大模型调用失败后的提示消息

</details>

<details>
<summary><b>v1.1.0</b></summary>

- 🐛 解决 URL 被拦截的问题
- 🐛 解决多轮消息发送失败的问题
- 🐛 修复部分图片无法接收的问题
- ✨ 增加支持 onboard 配置方式

</details>

---

## 🔗 相关链接

- [QQ 机器人官方文档](https://bot.q.qq.com/wiki/)
- [QQ 开放平台](https://q.qq.com/)
- [API v2 文档](https://bot.q.qq.com/wiki/develop/api-v2/)

---

## 📄 License

MIT
