<div align="center">

**简体中文 | [English](README.md)**

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

# QQ Bot — OpenClaw 渠道插件

**让你的 AI 助手接入 QQ — 私聊、群聊、富媒体，一个插件全搞定。**

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Platform](https://img.shields.io/badge/platform-OpenClaw-orange)](https://github.com/tencent-connect/openclaw-qqbot)
[![Node.js](https://img.shields.io/badge/Node.js->=18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

<br/>

扫描二维码加入群聊，一起交流

<img width="316" height="410" alt="QQ 群二维码" src="https://github.com/user-attachments/assets/d079ba89-ecd0-437f-9e66-92319801a325" />

</div>

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🔒 **多场景支持** | C2C 私聊、群聊 @消息、频道消息、频道私信 |
| 🖼️ **富媒体消息** | 支持图片、语音、视频、文件的收发 |
| 🎙️ **语音能力 (STT/TTS)** | 语音转文字自动转录 & 文字转语音回复 |
| ⏰ **定时推送** | 支持定时任务触发后主动推送消息 |
| 🔗 **URL 无限制** | 私聊可直接发送 URL |
| ⌨️ **输入状态** | 实时显示"Bot 正在输入中…"状态 |
| 🔄 **热更新** | 支持 npm 方式安装和无缝热更新 |
| 📝 **Markdown** | 完整支持 Markdown 格式消息 |
| 🛠️ **原生命令** | 支持 OpenClaw 原生命令 |

---

## 📸 功能展示

> **说明：** 本插件仅作为**消息通道**，负责在 QQ 和 OpenClaw 之间传递消息。图片理解、语音转录、AI 画图等能力取决于你配置的 **AI 模型**以及在 OpenClaw 中安装的 **skill**，而非插件本身提供。

### 🎙️ 语音消息（STT）

配置 STT 后，插件会自动将语音转录为文字再交给 AI 处理。整个过程对用户完全透明——发语音就像发文字一样自然，AI 听得懂你在说什么。

> **你**：*（发送一段语音）*"明天深圳天气怎么样"
>
> **QQBot**：明天（3月7日 周六）深圳的天气预报 🌤️ ...

<img width="360" src="docs/images/fc7b2236896cfba3a37c94be5d59ce3e_720.jpg" alt="听语音演示" />

### 📄 文件理解

用户发文件给 AI，AI 同样能接住。不管是一本小说还是一份报告，AI 会自动识别文件内容并给出智能回复。

> **你**：*（发送《战争与和平》TXT 文件）*
>
> **QQBot**：收到！你上传了列夫·托尔斯泰的《战争与和平》中文版文本。从内容来看，这是第一章的开头……你想让我做什么？

<img width="360" src="docs/images/07bff56ab68e03173d2af586eeb3bcee_720.jpg" alt="AI理解用户发送的文件" />

### 🖼️ 图片理解

如果主模型支持视觉（如腾讯混元 `hunyuan-vision`），用户发图片 AI 也能看懂。这是多模态模型的通用能力，非插件专属功能。

> **你**：*（发送一张图片）*
>
> **QQBot**：哈哈，好可爱！这是QQ企鹅穿上小龙虾套装吗？🦞🐧 ...

<img width="360" src="docs/images/59d421891f813b0d3c0cbe12574b6a72_720.jpg" alt="图片理解演示" />

### 🎨 AI 画图

> **你**：画一只猫咪
>
> **QQBot**：画好啦！一只可爱的简笔小猫咪🐱🎨

AI 通过 `<qqimg>路径</qqimg>` 发送图片，支持本地文件路径和网络 URL。格式：jpg/png/gif/webp/bmp。

<img width="360" src="docs/images/4645f2b3a20822b7f8d6664a708529eb_720.jpg" alt="发图片演示" />

### 🔊 语音回复（TTS）

> **你**：给我讲一个笑话
>
> **QQBot**：*（发送一条语音消息）*

AI 通过 `<qqvoice>路径</qqvoice>` 发送语音消息。格式：mp3/wav/silk/ogg，无需安装 ffmpeg。

<img width="360" src="docs/images/21dce8bfc553ce23d1bd1b270e9c516c.jpg" alt="发语音演示" />

### ⏰ 定时提醒（主动消息）

> **你**：5分钟后提醒我吃饭
>
> **QQBot**：先确认已创建提醒，到点后再主动推送语音 + 文本提醒

该能力依赖 OpenClaw cron 调度与主动消息能力。若未收到提醒，常见原因是 QQ 侧拦截了机器人主动消息。

<img width="360" src="docs/images/reminder.jpg" alt="定时提醒演示" />

### 📎 文件发送

> **你**：战争与和平的第一章截取一下发文件给我
>
> **QQBot**：*（发送 .txt 文件）*

AI 通过 `<qqfile>路径</qqfile>` 发送文件。任意格式，最大 20MB。

<img width="360" src="docs/images/17cada70df90185d45a2d6dd36e92f2f_720.jpg" alt="发文件演示" />

### 🎬 视频发送

> **你**：发一个演示视频给我
>
> **QQBot**：*（发送视频）*

AI 通过 `<qqvideo>路径</qqvideo>` 发送视频，支持本地文件和公网 URL。大文件（>5MB）自动提示上传进度。

<img width="360" src="docs/images/85d03b8a216f267ab7b2aee248a18a41_720.jpg" alt="发视频演示" />

### 富媒体标签参考

| 标签 | 方向 | 说明 |
|------|------|------|
| `<qqimg>路径</qqimg>` | 发送 | jpg/png/gif/webp/bmp，本地路径或 URL |
| `<qqvoice>路径</qqvoice>` | 发送 | mp3/wav/silk/ogg，无需 ffmpeg |
| `<qqfile>路径</qqfile>` | 发送 | 任意格式，最大 20MB |
| `<qqvideo>路径</qqvideo>` | 发送 | 本地路径或 URL |
| 语音 / 文件 / 图片 | 接收 | 自动转录(STT)、自动下载、或视觉分析 |

> **底层细节：** 30+ 种标签变体自动纠正、上传去重缓存、有序队列发送、音频格式多层降级。

---

## 🚀 快速开始

### 第一步 — 在 QQ 开放平台创建机器人

1. 前往 [QQ 开放平台](https://q.qq.com/)，用**手机 QQ 扫描页面二维码**即可注册/登录。若尚未注册，扫码后系统会自动完成注册并绑定你的 QQ 账号。

<img width="3246" height="1886" alt="Clipboard_Screenshot_1772980354" src="https://github.com/user-attachments/assets/d8491859-57e8-47e4-9d39-b21138be54d0" />

2. 手机 QQ 扫码后选择**同意**，即完成注册，进入 QQ 机器人配置页。
3. 点击**创建机器人**，即可直接新建一个 QQ 机器人。

<img width="720" alt="创建机器人" src="docs/images/create_robot.png" />

> ⚠️ 机器人创建后会自动出现在你的 QQ 消息列表中，并发送第一条消息。但在完成下面的配置之前，发消息会提示"该机器人去火星了"，属于正常现象。

<img width="400" alt="机器人打招呼" src="docs/images/bot_say_hello.jpg" />

4. 在机器人页面中找到 **AppID** 和 **AppSecret**，分别点击右侧**复制**按钮，保存到记事本或备忘录中。**AppSecret 不支持明文保存，离开页面后再查看会强制重置，请务必妥善保存。**

<img width="720" alt="找到 AppID 和 AppSecret" src="docs/images/find_appid_secret.png" />

> 详细图文教程请参阅 [官方指南](https://cloud.tencent.com/developer/article/2626045)。

### 第二步 — 安装插件

**方式一：通过 npm 安装（推荐）**

```bash
openclaw plugins install @tencent-connect/openclaw-qqbot
```

**方式二：一键安装并启动**

```bash
git clone https://github.com/tencent-connect/openclaw-qqbot.git && cd openclaw-qqbot
bash ./scripts/upgrade-and-run.sh --appid YOUR_APPID --secret YOUR_SECRET
```

脚本会自动完成：清理旧插件 → 安装依赖 → 注册插件 → 配置通道 → 启动服务。完成后可直接跳到[第四步](#第四步--启动并测试)。

**方式三：手动分步安装**

```bash
git clone https://github.com/tencent-connect/openclaw-qqbot.git && cd openclaw-qqbot
npm install --omit=dev
openclaw plugins install .
```

### 第三步 — 配置 OpenClaw

**方式一：通过 Wizard 配置（推荐）**

```bash
openclaw channels add --channel qqbot --token "AppID:AppSecret"
```

**方式二：编辑配置文件**

编辑 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "你的 AppID",
      "clientSecret": "你的 AppSecret"
    }
  }
}
```

### 第四步 — 启动与测试

```bash
openclaw gateway
```

打开 QQ，找到你的机器人，发条消息试试！

<div align="center">
<img width="500" alt="聊天演示" src="https://github.com/user-attachments/assets/b2776c8b-de72-4e37-b34d-e8287ce45de1" />
</div>

---

## ⚙️ 进阶配置

### 多账户配置（Multi-Bot）

支持在同一个 OpenClaw 实例下同时运行多个 QQ 机器人。

#### 配置方式

编辑 `~/.openclaw/openclaw.json`，在 `channels.qqbot` 下增加 `accounts` 字段：

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "111111111",
      "clientSecret": "secret-of-bot-1",

      "accounts": {
        "bot2": {
          "enabled": true,
          "appId": "222222222",
          "clientSecret": "secret-of-bot-2"
        },
        "bot3": {
          "enabled": true,
          "appId": "333333333",
          "clientSecret": "secret-of-bot-3"
        }
      }
    }
  }
}
```

**说明：**

- 顶层的 `appId` / `clientSecret` 是**默认账户**（accountId = `"default"`）
- `accounts` 下的每个 key（如 `bot2`、`bot3`）就是该账户的 `accountId`
- 每个账户都可以独立配置 `enabled`、`name`、`allowFrom`、`systemPrompt` 等字段
- 也可以不配顶层默认账户，只在 `accounts` 里配置所有机器人

通过 CLI 添加第二个机器人（如果框架支持 `--account` 参数）：

```bash
openclaw channels add --channel qqbot --account bot2 --token "222222222:secret-of-bot-2"
```

#### 向指定账户的用户发送消息

使用 `openclaw message send` 发消息时，需要通过 `--account` 参数指定使用哪个机器人发送：

```bash
# 使用默认机器人发送（不指定 --account 时自动使用 default）
openclaw message send --channel "qqbot" \
  --target "qqbot:c2c:OPENID" \
  --message "hello from default bot"

# 使用 bot2 发送
openclaw message send --channel "qqbot" \
  --account bot2 \
  --target "qqbot:c2c:OPENID" \
  --message "hello from bot2"
```

**Target 格式支持：**

| 格式 | 说明 |
|------|------|
| `qqbot:c2c:OPENID` | 私聊 |
| `qqbot:group:GROUP_OPENID` | 群聊 |
| `qqbot:channel:CHANNEL_ID` | 频道 |

> ⚠️ **注意**：每个机器人的用户 OpenID 是不同的。机器人 A 收到的用户 OpenID 不能用机器人 B 去发消息，否则会返回 500 错误。必须用对应机器人的 accountId 去给该机器人的用户发消息。

#### 工作原理

- 启动 `openclaw gateway` 后，所有 `enabled: true` 的账户会同时启动 WebSocket 连接
- 每个账户独立维护 Token 缓存（基于 `appId` 隔离），互不干扰
- 接收消息时，日志会带上 `[qqbot:accountId]` 前缀方便排查

---

### 语音能力配置（STT / TTS）

#### STT（语音转文字）— 自动转录用户发来的语音消息

STT 支持两级配置，按优先级查找：

| 优先级 | 配置路径 | 作用域 |
|--------|----------|--------|
| 1（highest） | `channels.qqbot.stt` | 插件专属 |
| 2（fallback） | `tools.media.audio.models[0]` | 框架级 |

```json
{
  "channels": {
    "qqbot": {
      "stt": {
        "provider": "your-provider",
        "model": "your-stt-model"
      }
    }
  }
}
```

- `provider` — 引用 `models.providers` 中的 key，自动继承 `baseUrl` 和 `apiKey`
- 设置 `enabled: false` 可禁用
- 配置后，用户发来的语音消息会自动转换（SILK→WAV）并转录为文字

#### TTS（文字转语音）— 机器人发送语音消息

| 优先级 | 配置路径 | 作用域 |
|--------|----------|--------|
| 1（highest） | `channels.qqbot.tts` | 插件专属 |
| 2（fallback） | `messages.tts` | 框架级 |

```json
{
  "channels": {
    "qqbot": {
      "tts": {
        "provider": "your-provider",
        "model": "your-tts-model",
        "voice": "your-voice"
      }
    }
  }
}
```

- `provider` — 引用 `models.providers` 中的 key，自动继承 `baseUrl` 和 `apiKey`
- `voice` — 语音音色
- 设置 `enabled: false` 可禁用（默认：`true`）
- 配置后，AI 可使用 `<qqvoice>` 标签生成并发送语音消息

---

## 🔄 升级

### 方式一：通过 npm 升级（推荐）

当前最新 npm 版本：`1.5.6`

```bash
bash ./scripts/npm-upgrade.sh
```

脚本会自动备份通道配置 → 卸载旧插件 → 安装新版本 → 恢复配置 → 重启网关。

```bash
# 指定版本号
bash ./scripts/npm-upgrade.sh --version 1.5.6
```

### 方式二：通过源码升级

运行一键脚本即可升级并重启：

```bash
bash ./scripts/upgrade-and-run.sh
```

不传 `--appid` / `--secret` 参数时，脚本会自动读取 `~/.openclaw/openclaw.json` 中已有的配置。

```bash
# 首次配置或需要覆盖时
bash ./scripts/upgrade-and-run.sh --appid YOUR_APPID --secret YOUR_SECRET
```

<details>
<summary>完整选项</summary>

| 选项 | 说明 |
|------|------|
| `--appid <id>` | QQ 机器人 AppID |
| `--secret <secret>` | QQ 机器人 AppSecret |
| `--markdown <yes\|no>` | 是否启用 Markdown 消息格式（默认: no） |
| `-h, --help` | 显示帮助 |

也支持环境变量：`QQBOT_APPID`、`QQBOT_SECRET`、`QQBOT_TOKEN`（AppID:Secret）。

</details>

---

## 🔀 从旧版插件迁移

如果你之前安装的是 `qqbot`、`@sliverp/qqbot`、`@tencent-connect/qqbot` 等关联插件，需要先卸载旧插件再安装新版本。

### 推荐：使用 npm-upgrade 脚本（自动处理）

```bash
bash ./scripts/npm-upgrade.sh
```

脚本会自动卸载所有历史版本的插件（`qqbot`、`@sliverp/qqbot`、`openclaw-qq` 等）、清理残留目录、备份恢复通道配置。

### 手动迁移

**1. 备份你的通道配置**

先记录 `~/.openclaw/openclaw.json` 中 `channels.qqbot` 的内容（`appId`、`clientSecret`、`allowFrom` 等），后续需要恢复。

**2. 卸载旧插件**

根据你之前安装的插件名，执行对应的卸载命令：

```bash
# 卸载可能存在的旧版插件（按实际情况选择）
openclaw plugins uninstall qqbot
openclaw plugins uninstall @sliverp/qqbot
openclaw plugins uninstall @tencent-connect/qqbot
openclaw plugins uninstall openclaw-qqbot
openclaw plugins uninstall openclaw-qq
```

如果 `plugins uninstall` 未能完全清理，手动删除残留目录：

```bash
rm -rf ~/.openclaw/extensions/qqbot
rm -rf ~/.openclaw/extensions/openclaw-qqbot
rm -rf ~/.openclaw/extensions/openclaw-qq
```

**3. 临时移除通道配置**

> ⚠️ 重要：`openclaw plugins install` 会校验配置文件。如果配置中存在 `channels.qqbot` 但对应插件尚未安装，会报 `unknown channel id: qqbot` 错误并拒绝安装。

安装前需要临时从 `~/.openclaw/openclaw.json` 中移除 `channels.qqbot` 配置段。

**4. 安装新版本**

```bash
openclaw plugins install @tencent-connect/openclaw-qqbot
```

**5. 恢复通道配置**

将之前备份的 `channels.qqbot` 配置写回 `~/.openclaw/openclaw.json`。

**6. 重启网关**

```bash
openclaw gateway restart
```

---

## 📚 文档与链接

- [命令参考](docs/commands.md) — OpenClaw CLI 常用命令
- [更新日志](CHANGELOG.md) — 各版本变更记录

## ⭐ Star History

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=tencent-connect/openclaw-qqbot&type=date&legend=top-left)](https://www.star-history.com/#tencent-connect/openclaw-qqbot&type=date&legend=top-left)

</div>
