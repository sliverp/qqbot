<div align="center">

**简体中文 | [English](README.md)**

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

# QQ Bot — OpenClaw 渠道插件

**让你的 AI 助手接入 QQ — 私聊、群聊、富媒体，一个插件全搞定。**

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Platform](https://img.shields.io/badge/platform-OpenClaw-orange)](https://github.com/tencent-connect/openclaw-qq)
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

<details>
<summary><b>🎙️ 语音消息（STT）</b> — 配置 STT 后，自动将语音转录为文字理解</summary>

> **你**：*（发送一段语音）*"明天深圳天气怎么样"
>
> **QQBot**：明天（3月7日 周六）深圳的天气预报 🌤️ ...

<img width="360" src="docs/images/fc7b2236896cfba3a37c94be5d59ce3e_720.jpg" alt="听语音演示" />

</details>

<details>
<summary><b>📄 文件理解</b> — 发文件给 AI，自动识别内容并智能回复</summary>

> **你**：*（发送《战争与和平》TXT 文件）*
>
> **QQBot**：收到！你上传了列夫·托尔斯泰的《战争与和平》中文版文本。从内容来看，这是第一章的开头……你想让我做什么？

<img width="360" src="docs/images/07bff56ab68e03173d2af586eeb3bcee_720.jpg" alt="AI理解用户发送的文件" />

</details>

<details>
<summary><b>🖼️ 图片理解</b> — 主模型支持视觉能力时，发图片 AI 也能看懂</summary>

> **你**：*（发送一张图片）*
>
> **QQBot**：哈哈，好可爱！这是QQ企鹅穿上小龙虾套装吗？🦞🐧 ...

<img width="360" src="docs/images/59d421891f813b0d3c0cbe12574b6a72_720.jpg" alt="图片理解演示" />

</details>

<details>
<summary><b>🎨 AI 画图</b> — 调用绘图工具生成图片，直接发到对话里</summary>

> **你**：画一只猫咪
>
> **QQBot**：给你画好了！🐱

<img width="360" src="docs/images/4645f2b3a20822b7f8d6664a708529eb_720.jpg" alt="发图片演示" />

</details>

<details>
<summary><b>🔊 语音回复（TTS）</b> — AI 把文字变成语音消息发出来</summary>

> **你**：用语音讲个笑话
>
> **QQBot**：*（发送一条语音消息）*

<img width="360" src="docs/images/21dce8bfc553ce23d1bd1b270e9c516c.jpg" alt="发语音演示" />

</details>

<details>
<summary><b>📎 文件发送</b> — 生成并发送任意格式文件，最大 20MB</summary>

> **你**：战争与和平的第一章截取一下发文件给我
>
> **QQBot**：*（发送 .txt 文件）*

<img width="360" src="docs/images/17cada70df90185d45a2d6dd36e92f2f_720.jpg" alt="发文件演示" />

</details>

<details>
<summary><b>🎬 视频发送</b> — 支持本地文件和公网 URL，大文件自动显示上传进度</summary>

> **你**：发一个演示视频给我
>
> **QQBot**：*（发送视频）*

<img width="360" src="docs/images/85d03b8a216f267ab7b2aee248a18a41_720.jpg" alt="发视频演示" />

</details>

> 富媒体能力（图片、语音、视频、文件）的完整说明请参阅 [富媒体指南](docs/qqbot-media-guide.md)。

---

## ⭐ Star History

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=tencent-connect/openclaw-qqbot&type=date&legend=top-left)](https://www.star-history.com/#tencent-connect/openclaw-qqbot&type=date&legend=top-left)

</div>

---

## 🚀 快速开始

### 第一步 — 在 QQ 开放平台创建机器人

1. 前往 [QQ 开放平台](https://q.qq.com/)，用**手机 QQ 扫描页面二维码**即可注册/登录。若尚未注册，扫码后系统会自动完成注册并绑定你的 QQ 账号。

<img width="3246" height="1886" alt="Clipboard_Screenshot_1772980354" src="https://github.com/user-attachments/assets/d8491859-57e8-47e4-9d39-b21138be54d0" />

2. 手机 QQ 扫码后选择**同意**，即完成注册，进入 QQ 机器人配置页。
3. 点击**创建机器人**，即可直接新建一个 QQ 机器人。

<img width="1982" height="1316" alt="Clipboard_Screenshot_1772980440" src="https://github.com/user-attachments/assets/3ccb494d-6e4d-462c-9218-b4dfd43a254f" />

4. 在机器人页面中找到 **AppID** 和 **AppSecret**，分别点击右侧**复制**按钮，保存到记事本或备忘录中。**AppSecret 不支持明文保存，离开页面后再查看会强制重置，请务必妥善保存。**

<img width="1670" height="1036" alt="Clipboard_Screenshot_1772980413" src="https://github.com/user-attachments/assets/b898d171-5711-4d42-bc07-2de967b119ec" />

> 详细图文教程请参阅 [官方指南](https://cloud.tencent.com/developer/article/2626045)。

> ⚠️ 机器人创建后会自动出现在你的 QQ 消息列表中，并发送第一条消息。但在完成下面的配置之前，发消息会提示"该机器人去火星了"，属于正常现象。

### 第二步 — 安装插件

**方式一：一键安装并启动（推荐）**

```bash
git clone https://github.com/tencent-connect/openclaw-qq.git && cd openclaw-qq
bash ./scripts/upgrade-and-run.sh --appid YOUR_APPID --secret YOUR_SECRET
```

脚本会自动完成：清理旧插件 → 安装依赖 → 注册插件 → 配置通道 → 启动服务。完成后可直接跳到[第四步](#第四步--启动并测试)。

**方式二：手动分步安装**

```bash
git clone https://github.com/tencent-connect/openclaw-qq.git && cd openclaw-qq
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

## 🤖 多账户配置（Multi-Bot）

支持在同一个 OpenClaw 实例下同时运行多个 QQ 机器人。

### 配置方式

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

### 向指定账户的用户发送消息

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

### 工作原理

- 启动 `openclaw gateway` 后，所有 `enabled: true` 的账户会同时启动 WebSocket 连接
- 每个账户独立维护 Token 缓存（基于 `appId` 隔离），互不干扰
- 接收消息时，日志会带上 `[qqbot:accountId]` 前缀方便排查

---

## 🎙️ 语音能力配置（可选）

### STT（语音转文字）— 自动转录用户发来的语音消息

STT 支持两级配置，按优先级查找：

| 优先级 | 配置路径 | 作用域 |
|--------|----------|--------|
| 1（最高） | `channels.qqbot.stt` | 插件专属 |
| 2（回退） | `tools.media.audio.models[0]` | 框架级 |

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

### TTS（文字转语音）— 机器人发送语音消息

| 优先级 | 配置路径 | 作用域 |
|--------|----------|--------|
| 1（最高） | `channels.qqbot.tts` | 插件专属 |
| 2（回退） | `messages.tts` | 框架级 |

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

### 通过 OpenClaw / npm 升级

> npm 包即将发布，届时可通过以下方式安装和升级：
>
> ```bash
> openclaw plugins install openclaw-qqbot@latest
> openclaw plugins upgrade openclaw-qqbot@latest
> ```

### 通过 upgrade-and-run.sh 一键升级

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

### 通过 pull-latest.sh（Git 源码更新）

```bash
bash ./scripts/pull-latest.sh
```

<details>
<summary>选项</summary>

```bash
bash ./scripts/pull-latest.sh --branch main            # 指定分支（默认 main）
bash ./scripts/pull-latest.sh --force                   # 跳过交互，强制更新
bash ./scripts/pull-latest.sh --repo <git-url>          # 使用其他仓库地址
```

</details>

### 从源码升级

```bash
git clone https://github.com/tencent-connect/openclaw-qq.git && cd openclaw-qq
npm install --omit=dev
bash ./scripts/upgrade.sh
openclaw plugins install .
openclaw channels add --channel qqbot --token "AppID:AppSecret"
openclaw gateway restart
```

---

## 📚 文档

- [富媒体指南](docs/qqbot-media-guide.md) — 图片、语音、视频、文件
- [命令参考](docs/commands.md) — OpenClaw CLI 常用命令
- [更新日志](docs/changelog/) — 各版本变更记录（[最新: 1.5.4](docs/changelog/1.5.4.md)）


