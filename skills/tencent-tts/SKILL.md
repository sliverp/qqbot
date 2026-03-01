---
name: tencent-tts
description: 腾讯云语音合成技能，将文本转换为语音文件。支持预设音色和一句话版声音复刻（克隆音色）。
homepage: https://cloud.tencent.com/product/tts
metadata: {"openclaw":{"emoji":"🎙️","requires":{"bins":["python3"],"py":["tencentcloud-sdk-python"],"env":["TENCENT_SECRET_ID","TENCENT_SECRET_KEY"]},"primaryEnv":"TENCENT_SECRET_KEY"}}
---

# Tencent TTS

将文本转换为 WAV 格式语音文件，支持多种音色和克隆音色。

## Usage

```bash
{baseDir}/scripts/tts.py "<文本>" <输出路径.wav>
```

## 使用预设音色

```bash
# 基础用法（默认音色）
tts.py "你好，这是语音测试" /tmp/tts_output.wav
```

## 使用克隆音色

需要在 [腾讯云声音复刻控制台](https://console.cloud.tencent.com/vrs) 中创建音色复刻任务，并获取音色ID

```bash
# 一句话版声音复刻
export TENCENT_FAST_VOICE_TYPE="你的FastVoiceTypeID"
tts.py "你好，这是我的专属声音" /tmp/my_voice.wav
```

## Configuration

必需环境变量：
- `TENCENT_SECRET_ID` - 腾讯云 Secret ID
- `TENCENT_SECRET_KEY` - 腾讯云 Secret Key

可选环境变量：
- `TENCENT_REGION` - 地域（默认：ap-beijing）
- `TENCENT_VOICE_TYPE` - 音色类型（默认：502003，仅用于预设音色）
- `TENCENT_FAST_VOICE_TYPE` - 一句话版声音复刻音色 ID（设置后自动使用克隆音色，同时会自动忽略 TENCENT_VOICE_TYPE）
- `TENCENT_TTS_SPEED` - 语速（-2到6，默认：0）
- `TENCENT_TTS_LANGUAGE` - 主语言（1=中文，2=英文，默认：1）
- `TENCENT_TTS_VOLUME` - 音量（-10到10，默认：0）

## Notes

- 单次请求限制约 **150 个汉字** 或 **500 个英文字母**
- 输出格式：WAV（24kHz, 16bit, 单声道）
- 需要稳定的网络连接访问腾讯云 API
