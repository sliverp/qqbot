<div align="center">

# QQ Bot Channel Plugin for Openclaw(Clawdbot/Moltbot)

QQ 开放平台 Bot API 的 Openclaw 渠道插件，支持 C2C 私聊、群聊 @消息、频道消息。

The Openclaw channel plugin of the Bot API of the QQ Open Platform supports C2C private chats, group chat @ messages, and channel messages.

[![npm version](https://img.shields.io/badge/npm-v1.4.1-blue)](https://www.npmjs.com/package/@sliverp/qqbot)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Platform](https://img.shields.io/badge/platform-Openclaw-orange)](https://github.com/sliverp/openclaw)
[![Node.js](https://img.shields.io/badge/Node.js->=18-339933)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6)](https://www.typescriptlang.org/)



扫描二维码加入群聊，一起交流

<img width="316" height="410" alt="Clipboard_Screenshot_1772443710" src="https://github.com/user-attachments/assets/d079ba89-ecd0-437f-9e66-92319801a325" />

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

## ⭐ Star History
<div align="center">
  
[![Star History Chart](https://api.star-history.com/svg?repos=sliverp/qqbot&type=date&legend=top-left)](https://www.star-history.com/#sliverp/qqbot&type=date&legend=top-left)

</div>

# QQ

QQ is a widely-used instant messaging platform that provides various communication capabilities such as text, voice, images, and files. It supports collaborative scenarios like group chats and channels, making it suitable for both personal communication and team collaboration.

This integration method connects OpenClaw with a QQ Bot. It utilizes the platform's long-connection event subscription mechanism to receive message and event callbacks, enabling stable and secure message exchange and automation capability integration without exposing a public webhook address.

# Step 1: Install the QQ Bot Plugin

Install via the OpenClaw plugins command.

```
openclaw plugins install @sliverp/qqbot@latest
```

Install from source code:

```
git clone https://github.com/sliverp/qqbot.git && cd qqbot
openclaw plugins install .
```

# Step 2: Create a QQ Bot

## 1. Register on the QQ Open Platform

Go to the official website of the Tencent QQ Open Platform. You cannot log in directly with your personal QQ account by default; you need to register a new QQ Open Platform account.
<img width="2140" height="1004" alt="1" src="https://github.com/user-attachments/assets/d76a780c-5040-43fb-ac41-5808f975ae4b" />

After the initial registration, follow the platform's instructions to set up a super administrator.

<img width="2556" height="1744" alt="2" src="https://github.com/user-attachments/assets/ad0a54d5-6997-4f52-ae8f-bea71aa11c30" />
After successfully scanning the QR code with your mobile QQ, proceed to the next step to fill in the relevant entity information.

Using "Individual" as an example here, follow the prompts to enter your name, ID number, phone number, and verification code, then click continue to proceed to the facial recognition step.
<img width="2544" height="1744" alt="3" src="https://github.com/user-attachments/assets/b85c11f8-5627-4e08-b522-b38c4929bcb6" />

Use your mobile QQ to scan the QR code for facial recognition.
<img width="2542" height="1272" alt="4" src="https://github.com/user-attachments/assets/d0db5539-56ef-4189-930f-595348892bef" />

Once the facial recognition review is approved, you can log in to the QQ Open Platform.
<img width="2356" height="1308" alt="5" src="https://github.com/user-attachments/assets/c1875b27-fefc-4a1c-81ef-863da8b15ec6" />

## 2. Create a QQ Bot

On the QQ Open Platform's QQ Bot page, you can create a bot.
<img width="2334" height="1274" alt="6" src="https://github.com/user-attachments/assets/8389c38d-6662-46d0-ae04-92af374b61ef" />
<img width="2316" height="1258" alt="7" src="https://github.com/user-attachments/assets/15cfe57a-0404-4b02-85fe-42a22cf96d01" />

After the QQ Bot is created, you can select it and click to enter the management page.
<img width="3002" height="1536" alt="8" src="https://github.com/user-attachments/assets/7c0c7c69-29db-457f-974a-4aa52ebd7973" />

On the QQ Bot management page, obtain the current bot's AppID and AppSecret, copy them, and save them to your personal notepad or memo (please ensure data security and do not leak them). They will be needed later in "Step 3: Configuring OpenClaw".

Note: For security reasons, the QQ Bot's AppSecret is not stored in plain text. If you view it for the first time or forget it, you need to regenerate it.
<img width="2970" height="1562" alt="9" src="https://github.com/user-attachments/assets/c7fc3094-2840-4780-a202-47b2c2b74e50" />
<img width="1258" height="594" alt="10" src="https://github.com/user-attachments/assets/4445bede-e7d5-4927-9821-039e7ad8f1f5" />

## 3. Sandbox Configuration

On the QQ Bot's "Development Management" page, in the "Sandbox Configuration" section, set up private chat (select "Configure in Message List").

You can configure this according to your own usage scenario, or you can complete the subsequent steps and then return to this step to operate.

⚠️ Note:
The QQ Bot created here does not need to be published and made available to all QQ users. It can be used for personal (sandbox) debugging and experience.
The QQ Open Platform does not support "Configuration in QQ Groups" for bots; it only supports private chat with the QQ Bot.
<img width="1904" height="801" alt="11" src="https://github.com/user-attachments/assets/f3940a87-aae7-4c89-8f9a-c94fb52cd3ea" />

Note: When selecting "Configure in Message List", you need to first add members, and then use the QQ scan code of that member to add the bot.
<img width="2582" height="484" alt="12" src="https://github.com/user-attachments/assets/5631fe76-2205-4b1e-b463-75fa3a397464" />
Note here that after successfully adding a member, you still need to use QQ scan code to add the bot.

<img width="2286" height="1324" alt="13" src="https://github.com/user-attachments/assets/cbf379be-ef6e-4391-8cb1-67c08aad2d43" />
At this point, after adding the bot to your QQ account, you still cannot have a normal conversation with it. You will receive a prompt saying "The bot has gone to Mars, please try again later." This is because the QQ bot has not yet been connected to the OpenClaw application.

You need to proceed with the following steps to configure the QQ bot's AppID and AppSecret for the OpenClaw application.

<img width="872" height="1052" alt="14" src="https://github.com/user-attachments/assets/0c02aaf6-6cf9-419c-a6ab-36398d73c5ba" />

(Optional) You can also add more members by referring to the previous steps: First, add a new member in the member management page, then add the member in the sandbox configuration page. After that, the new member can add this QQ bot by scanning the QR code with QQ.
<img width="3006" height="1504" alt="15" src="https://github.com/user-attachments/assets/cecef3a6-0596-4da0-8b92-8d67b8f3cdca" />
<img width="2902" height="1394" alt="16" src="https://github.com/user-attachments/assets/eb98ffce-490f-402c-8b0c-af7ede1b1303" />
<img width="1306" height="672" alt="17" src="https://github.com/user-attachments/assets/799056e3-82a6-44bc-9e3d-9c840faafa41" />

# Step 3: Configure OpenClaw

## Method 1: Configure via Wizard (Recommended)

Add the qqbot channel and input the AppID and AppSecret obtained in Step 2.

```
openclaw channels add --channel qqbot --token "AppID:AppSecret"
```

## Method 2: Configure via Configuration File

Edit ~/.openclaw/openclaw.json:

``` json
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

## Voice Capabilities (Optional)

### STT (Speech-to-Text) — Transcribe incoming voice messages

STT reuses your existing model provider configuration. Add an audio model entry in `tools.media.audio.models`:

``` json
{
  "tools": {
    "media": {
      "audio": {
        "models": [
          {
            "provider": "openai",
            "model": "whisper-1"
          }
        ]
      }
    }
  },
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-xxx"
      }
    }
  }
}
```

- `provider` — references a key in `models.providers` to inherit `baseUrl` and `apiKey` (default: `"openai"`)
- `model` — STT model name (default: `"whisper-1"`)
- You can also set `baseUrl` / `apiKey` directly in the audio model entry to override the provider defaults
- When configured, incoming voice messages are automatically converted (SILK→WAV) and transcribed

### TTS (Text-to-Speech) — Send voice messages

Configure TTS under `channels.qqbot.tts`:

``` json
{
  "channels": {
    "qqbot": {
      "tts": {
        "provider": "openai",
        "model": "tts-1",
        "voice": "alloy"
      }
    }
  }
}
```

- `provider` — references a key in `models.providers` to inherit `baseUrl` and `apiKey` (default: `"openai"`)
- `model` — TTS model name (default: `"tts-1"`)
- `voice` — voice variant (default: `"alloy"`)
- `baseUrl` / `apiKey` — optional overrides for the provider defaults
- `enabled` — set to `false` to disable (default: `true`)
- When configured, the AI can use `<qqvoice>` tags to generate and send voice messages via OpenAI-compatible TTS API

# Step 4: Start and Test

## 1. Start the gateway

```
openclaw gateway
```

## 2. Chat with the QQbot in QQ

<img width="990" height="984" alt="18" src="https://github.com/user-attachments/assets/b2776c8b-de72-4e37-b34d-e8287ce45de1" />


# Upgrade
## Using openclaw/npm(Recommendation)

> only for installed by`openclaw plugins install`

```
openclaw plugins upgrade @sliverp/qqbot@latest
```

## Using npx
```
npx -y @sliverp/qqbot@latest upgrade
```

## Using resource code
```
git clone https://github.com/sliverp/qqbot.git && cd qqbot 

# run upgrade script
bash ./scripts/upgrade.sh

# re-install
clawdbot plugins install .

# re-config
clawdbot channels add --channel qqbot --token "AppID:AppSecret"

# restart gateway
clawdbot gateway restart
```

# Other Language README
[简体中文](README.zh.md)
