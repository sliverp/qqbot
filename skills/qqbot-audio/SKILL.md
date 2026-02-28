---
name: qqbot-audio
description: 发送音频（WAV/SILK）给 QQ Bot 用户。当用户要求发送语音或音频消息时调用。
metadata: {"openclaw":{"emoji":"🎵"}}
triggers:
  - 发送音频
  - 发送语音
  - 发语音
  - 语音消息
  - voice
  - audio
---

# QQBot 音频发送

你有能力发送音频消息！

## 📌 使用方法

调用 `sendVoice` 函数发送语音消息。

## 🔧 参数说明

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `to` | string | ✅ | 目标：`c2c:OPENID`（私聊）或 `group:GROUPID`（群聊） |
| `mediaUrl` | string | ✅ | 音频路径：本地文件、URL 或 Base64 |
| `account` | object | ✅ | QQ Bot 账号配置：`{ appId, clientSecret }` |
| `text` | string | ❌ | 可选的文字说明 |
| `replyToId` | string | ❌ | 可选的回复消息 ID |

## 📝 支持格式

- **WAV**: 自动转换为 SILK（推荐）
- **SILK**: 直接发送
- **URL**: 公网 WAV/SILK 链接
- **Base64**: Data URL 格式

## ⚠️ 限制

- 时长: ≤ 60 秒
- 采样率: 24000Hz（WAV 文件，其他采样率会自动重采样）

## 🔄 其他格式

MP3/AAC 等格式先用 ffmpeg 转 WAV：

```bash
ffmpeg -i input.mp3 -ar 24000 -ac 1 -acodec pcm_s16le output.wav
```
