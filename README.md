<div align="center">



<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

# QQ Bot Channel Plugin for OpenClaw

**Connect your AI assistant to QQ — private chat, group chat, and rich media, all in one plugin.**

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Platform](https://img.shields.io/badge/platform-OpenClaw-orange)](https://github.com/tencent-connect/openclaw-qqbot)
[![Node.js](https://img.shields.io/badge/Node.js->=18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

<br/>

**[简体中文](README.zh.md) | English**

Scan to join the QQ group chat

<img width="300" height="540" alt="Clipboard_Screenshot_1773047715" src="https://github.com/user-attachments/assets/4d2d2337-229a-42ad-97ab-8a6d0607f296" />


</div>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔒 **Multi-Scene** | C2C private chat, group @messages, channel messages, channel DMs |
| 🖼️ **Rich Media** | Send & receive images, voice, video, and files |
| 🎙️ **Voice (STT/TTS)** | Speech-to-text transcription & text-to-speech replies |
| ⏰ **Scheduled Push** | Proactive message delivery via scheduled tasks |
| 🔗 **URL Support** | Direct URL sending in private chat (no restrictions) |
| ⌨️ **Typing Indicator** | "Bot is typing..." status shown in real-time |
| 🔄 **Hot Reload** | Install via npm with seamless hot updates |
| 📝 **Markdown** | Full Markdown formatting support |
| 🛠️ **Commands** | Native OpenClaw command integration |

---

## 📸 Feature Showcase

> **Note:** This plugin serves as a **message channel** only — it relays messages between QQ and OpenClaw. Capabilities like image understanding, voice transcription, drawing, etc. depend on the **AI model** you configure and the **skills** installed in OpenClaw, not on this plugin itself.

### 🎙️ Voice Messages (STT)

With STT configured, the plugin automatically transcribes voice messages to text before passing them to AI. The whole process is transparent to the user — sending voice feels as natural as sending text.

> **You**: *(send a voice message)* "What's the weather like tomorrow in Shenzhen?"
>
> **QQBot**: Tomorrow (March 7, Saturday) Shenzhen weather forecast 🌤️ ...

<img width="360" src="docs/images/fc7b2236896cfba3a37c94be5d59ce3e_720.jpg" alt="Voice STT Demo" />

### 📄 File Understanding

Send any file to the bot — novels, reports, spreadsheets — AI automatically recognizes the content and gives an intelligent reply.

> **You**: *(send a TXT file of "War and Peace")*
>
> **QQBot**: Got it! You uploaded the Chinese version of "War and Peace" by Leo Tolstoy. This appears to be the opening of Chapter 1...

<img width="360" src="docs/images/07bff56ab68e03173d2af586eeb3bcee_720.jpg" alt="File Understanding Demo" />

### 🖼️ Image Understanding

If your main model supports vision (e.g. Tencent Hunyuan `hunyuan-vision`), AI can understand images too. This is a general multimodal capability, not plugin-specific.

> **You**: *(send an image)*
>
> **QQBot**: Haha, so cute! Is that a QQ penguin in a lobster costume? 🦞🐧 ...

<img width="360" src="docs/images/59d421891f813b0d3c0cbe12574b6a72_720.jpg" alt="Image Understanding Demo" />

### 🎨 Image Generation

> **You**: Draw me a cat
>
> **QQBot**: Here you go! 🐱

AI sends images via `<qqimg>path</qqimg>`. Supports local paths and URLs. Formats: jpg/png/gif/webp/bmp.

<img width="360" src="docs/images/4645f2b3a20822b7f8d6664a708529eb_720.jpg" alt="Image Generation Demo" />

### 🔊 Voice Reply (TTS)

> **You**: Tell me a joke in voice
>
> **QQBot**: *(sends a voice message)*

AI sends voice via `<qqvoice>path</qqvoice>`. Formats: mp3/wav/silk/ogg. No ffmpeg required.

<img width="360" src="docs/images/21dce8bfc553ce23d1bd1b270e9c516c.jpg" alt="TTS Voice Demo" />

### ⏰ Scheduled Reminder (Proactive Message)

> **You**: Remind me to eat in 5 minutes
>
> **QQBot**: confirms the reminder first, then proactively sends a voice + text reminder when time is up

This capability depends on OpenClaw cron scheduling and proactive messaging. If no reminder arrives, a common reason is QQ-side interception of bot proactive messages.

<img width="360" src="docs/images/reminder.jpg" alt="Scheduled Reminder Demo" />

### 📎 File Sending

> **You**: Extract chapter 1 of War and Peace and send it as a file
>
> **QQBot**: *(sends a .txt file)*

AI sends files via `<qqfile>path</qqfile>`. Any format, up to 20MB.

<img width="360" src="docs/images/17cada70df90185d45a2d6dd36e92f2f_720.jpg" alt="File Sending Demo" />

### 🎬 Video Sending

> **You**: Send me a demo video
>
> **QQBot**: *(sends a video)*

AI sends videos via `<qqvideo>path</qqvideo>`. Supports local files and URLs. Large files (>5MB) auto-show upload progress.

<img width="360" src="docs/images/85d03b8a216f267ab7b2aee248a18a41_720.jpg" alt="Video Sending Demo" />

### Rich Media Tag Reference

| Tag | Direction | Notes |
|-----|-----------|-------|
| `<qqimg>path</qqimg>` | Send | jpg/png/gif/webp/bmp, local path or URL |
| `<qqvoice>path</qqvoice>` | Send | mp3/wav/silk/ogg, no ffmpeg required |
| `<qqfile>path</qqfile>` | Send | Any format, up to 20MB |
| `<qqvideo>path</qqvideo>` | Send | Local path or URL |
| Voice / File / Image | Receive | Auto-transcribe (STT), auto-download, or vision analysis |

> **Under the hood:** 30+ tag variant auto-correction, upload dedup caching, ordered queue delivery, and multi-layer audio format fallback.

---

## 🚀 Getting Started

### Step 1 — Create a QQ Bot on the QQ Open Platform

1. Go to the [QQ Open Platform](https://q.qq.com/) and **scan the QR code with your phone QQ** to register / log in. If you haven't registered before, scanning will automatically complete the registration and bind your QQ account.

<img width="3246" height="1886" alt="Clipboard_Screenshot_1772980354" src="https://github.com/user-attachments/assets/d8491859-57e8-47e4-9d39-b21138be54d0" />

2. After scanning, tap **Agree** on your phone — you'll land on the bot configuration page.
3. Click **Create Bot** to create a new QQ bot.

<img width="720" alt="Create Bot" src="docs/images/create_robot.png" />

> ⚠️ The bot will automatically appear in your QQ message list and send a first message. However, it will reply "The bot has gone to Mars" until you complete the configuration steps below.

<img width="400" alt="Bot Say Hello" src="docs/images/bot_say_hello.jpg" />

4. Find **AppID** and **AppSecret** on the bot's page, click **Copy** for each, and save them somewhere safe (e.g., a notepad). **AppSecret is not stored in plaintext — if you leave the page without saving it, you'll have to regenerate a new one.**

<img width="720" alt="Find AppID and AppSecret" src="docs/images/find_appid_secret.png" />

> For a step-by-step walkthrough with screenshots, see the [official guide](https://cloud.tencent.com/developer/article/2626045).

### Step 2 — Install the Plugin

**Option A: Install via npm (Recommended)**

```bash
openclaw plugins install @tencent-connect/openclaw-qqbot
```

**Option B: One-Click Install & Run**

```bash
git clone https://github.com/tencent-connect/openclaw-qqbot.git && cd openclaw-qqbot
bash ./scripts/upgrade-and-run.sh --appid YOUR_APPID --secret YOUR_SECRET
```

The script handles everything: cleanup old plugins → install deps → register plugin → configure channel → start service. Once done, skip to [Step 4](#step-4--start--test).

**Option C: Manual Step-by-Step**

```bash
git clone https://github.com/tencent-connect/openclaw-qqbot.git && cd openclaw-qqbot
npm install --omit=dev
openclaw plugins install .
```

### Step 3 — Configure OpenClaw

**Option 1: CLI Wizard (Recommended)**

```bash
openclaw channels add --channel qqbot --token "AppID:AppSecret"
```

**Option 2: Edit Config File**

Edit `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "Your AppID",
      "clientSecret": "Your AppSecret"
    }
  }
}
```

### Step 4 — Start & Test

```bash
openclaw gateway
```

Open QQ, find your bot, and send a message!

<div align="center">
<img width="500" alt="Chat Demo" src="https://github.com/user-attachments/assets/b2776c8b-de72-4e37-b34d-e8287ce45de1" />
</div>

---

## ⚙️ Advanced Configuration

### Multi-Account Setup (Multi-Bot)

Run multiple QQ bots under a single OpenClaw instance.

#### Configuration

Edit `~/.openclaw/openclaw.json` and add an `accounts` field under `channels.qqbot`:

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

**Notes:**

- The top-level `appId` / `clientSecret` is the **default account** (accountId = `"default"`)
- Each key under `accounts` (e.g. `bot2`, `bot3`) is the `accountId` for that bot
- Each account can independently configure `enabled`, `name`, `allowFrom`, `systemPrompt`, etc.
- You may also skip the top-level default account and only configure bots inside `accounts`

Add a second bot via CLI (if the framework supports the `--account` parameter):

```bash
openclaw channels add --channel qqbot --account bot2 --token "222222222:secret-of-bot-2"
```

#### Sending Messages to a Specific Account's Users

When using `openclaw message send`, specify which bot to use with the `--account` parameter:

```bash
# Send with the default bot (no --account = uses "default")
openclaw message send --channel "qqbot" \
  --target "qqbot:c2c:OPENID" \
  --message "hello from default bot"

# Send with bot2
openclaw message send --channel "qqbot" \
  --account bot2 \
  --target "qqbot:c2c:OPENID" \
  --message "hello from bot2"
```

**Target Formats:**

| Format | Description |
|--------|-------------|
| `qqbot:c2c:OPENID` | Private chat (C2C) |
| `qqbot:group:GROUP_OPENID` | Group chat |
| `qqbot:channel:CHANNEL_ID` | Guild channel |

> ⚠️ **Important**: Each bot has its own set of user OpenIDs. An OpenID received by Bot A **cannot** be used to send messages via Bot B — this will result in a 500 error. Always use the matching bot's `accountId` to send messages to its users.

#### How It Works

- When `openclaw gateway` starts, all accounts with `enabled: true` launch their own WebSocket connections
- Each account maintains an independent Token cache (isolated by `appId`), preventing cross-contamination
- Incoming message logs are prefixed with `[qqbot:accountId]` for easy debugging

---

### Voice Configuration (STT / TTS)

#### STT (Speech-to-Text) — Transcribe Incoming Voice Messages

STT supports two-level configuration with priority fallback:

| Priority | Config Path | Scope |
|----------|------------|-------|
| 1 (highest) | `channels.qqbot.stt` | Plugin-specific |
| 2 (fallback) | `tools.media.audio.models[0]` | Framework-level |

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

- `provider` — references a key in `models.providers` to inherit `baseUrl` and `apiKey`
- Set `enabled: false` to disable
- When configured, incoming voice messages are automatically converted (SILK→WAV) and transcribed

#### TTS (Text-to-Speech) — Send Voice Messages

| Priority | Config Path | Scope |
|----------|------------|-------|
| 1 (highest) | `channels.qqbot.tts` | Plugin-specific |
| 2 (fallback) | `messages.tts` | Framework-level |

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

- `provider` — references a key in `models.providers` to inherit `baseUrl` and `apiKey`
- `voice` — voice variant
- Set `enabled: false` to disable (default: `true`)
- When configured, AI can use `<qqvoice>` tags to generate and send voice messages

---

## 🔄 Upgrade

### Option 1: Upgrade via npm (Recommended)

Current latest npm version: `1.5.6`

```bash
bash ./scripts/npm-upgrade.sh
```

The script automatically backs up channel config → uninstalls old plugins → installs new version → restores config → restarts gateway.

```bash
# Specify exact version
bash ./scripts/npm-upgrade.sh --version 1.5.6
```

### Option 2: Upgrade via Source

Run the one-click script to upgrade and restart:

```bash
bash ./scripts/upgrade-and-run.sh
```

When no `--appid` / `--secret` is provided, the script reads existing config from `~/.openclaw/openclaw.json` automatically.

```bash
# First-time or override credentials
bash ./scripts/upgrade-and-run.sh --appid YOUR_APPID --secret YOUR_SECRET
```

<details>
<summary>Full Options</summary>

| Option | Description |
|--------|-------------|
| `--appid <id>` | QQ Bot AppID |
| `--secret <secret>` | QQ Bot AppSecret |
| `--markdown <yes\|no>` | Enable Markdown format (default: no) |
| `-h, --help` | Show help |

Environment variables `QQBOT_APPID`, `QQBOT_SECRET`, `QQBOT_TOKEN` (AppID:Secret) are also supported.

</details>

---

## 🔀 Migrating from Legacy Plugins

If you previously installed `qqbot`, `@sliverp/qqbot`, `@tencent-connect/qqbot`, or other related legacy plugins, you need to uninstall the old plugin before installing the new version.

### Recommended: Use npm-upgrade Script (Automatic)

```bash
bash ./scripts/npm-upgrade.sh
```

The script automatically uninstalls all legacy plugin variants (`qqbot`, `@sliverp/qqbot`, `openclaw-qq`, etc.), cleans up residual directories, and backs up/restores channel config.

### Manual Migration

**1. Back up your channel config**

Save the `channels.qqbot` section from `~/.openclaw/openclaw.json` (including `appId`, `clientSecret`, `allowFrom`, etc.) — you'll need to restore it later.

**2. Uninstall old plugins**

Run the appropriate uninstall command(s) based on what you had installed:

```bash
# Uninstall legacy plugin variants (pick the ones that apply)
openclaw plugins uninstall qqbot
openclaw plugins uninstall @sliverp/qqbot
openclaw plugins uninstall @tencent-connect/qqbot
openclaw plugins uninstall openclaw-qqbot
openclaw plugins uninstall openclaw-qq
```

If `plugins uninstall` doesn't fully clean up, manually remove residual directories:

```bash
rm -rf ~/.openclaw/extensions/qqbot
rm -rf ~/.openclaw/extensions/openclaw-qqbot
rm -rf ~/.openclaw/extensions/openclaw-qq
```

**3. Temporarily remove channel config**

> ⚠️ Important: `openclaw plugins install` validates the config file. If `channels.qqbot` exists but no plugin provides that channel, it will fail with `unknown channel id: qqbot`.

Before installing, temporarily remove the `channels.qqbot` section from `~/.openclaw/openclaw.json`.

**4. Install the new version**

```bash
openclaw plugins install @tencent-connect/openclaw-qqbot
```

**5. Restore channel config**

Write back the previously saved `channels.qqbot` config to `~/.openclaw/openclaw.json`.

**6. Restart the gateway**

```bash
openclaw gateway restart
```

---

## 📚 Documentation & Links

- [Command Reference](docs/commands.md) — OpenClaw CLI commands
- [Changelog](CHANGELOG.md) — release notes

## ⭐ Star History

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=tencent-connect/openclaw-qqbot&type=date&legend=top-left)](https://www.star-history.com/#tencent-connect/openclaw-qqbot&type=date&legend=top-left)

</div>
