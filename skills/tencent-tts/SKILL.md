---
name: tencent-tts
description: 腾讯云语音合成技能，将文本转换为语音文件。当用户要求语音回复或朗读文本时使用。
homepage: https://cloud.tencent.com/product/tts
metadata: {"openclaw":{"emoji":"🎙️","requires":{"bins":["python3"],"py":["tencentcloud-sdk-python"],"env":["TENCENT_SECRET_ID","TENCENT_SECRET_KEY"]},"primaryEnv":"TENCENT_SECRET_KEY"}}
---

# Tencent TTS

将文本转换为 WAV 格式语音文件，支持多种音色。

## Usage

```bash
{baseDir}/scripts/tts.py "<文本>" <输出路径.wav>
```

## Examples

```bash
# 基础用法
tts.py "你好，这是语音测试" /tmp/tts_output.wav

# 使用不同音色
TENCENT_VOICE_TYPE=1004 tts.py "这是男声朗读" /tmp/male_voice.wav
```

## Configuration

必需环境变量：
- `TENCENT_SECRET_ID` - 腾讯云 Secret ID
- `TENCENT_SECRET_KEY` - 腾讯云 Secret Key

可选环境变量：
- `TENCENT_REGION` - 地域（默认：ap-beijing）
- `TENCENT_VOICE_TYPE` - 音色类型（默认：502003）

完整音色列表请参考 [腾讯云官方文档](https://cloud.tencent.com/document/product/1073/92668)

## Notes

- 单次请求限制约 **200 字**
- 输出格式：WAV（24kHz, 16bit, 单声道）
- 需要稳定的网络连接访问腾讯云 API
