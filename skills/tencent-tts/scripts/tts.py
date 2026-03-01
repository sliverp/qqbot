#!/usr/bin/env python3
"""
腾讯云 TTS (Text-to-Speech) 语音合成工具
使用腾讯云 TextToVoice API 生成 WAV 格式语音文件

支持：
- 普通预设音色
- 一句话版声音复刻（克隆音色）- 推荐！
"""

import sys
import os
import re
import uuid
import struct
import base64
from typing import Optional

# 腾讯云 SDK
from tencentcloud.common import credential
from tencentcloud.common.exception.tencent_cloud_sdk_exception import TencentCloudSDKException
from tencentcloud.tts.v20190823 import tts_client, models


def pcm_to_wav(pcm_data: bytes, sample_rate: int = 24000) -> bytes:
    """将 PCM 音频数据封装为 WAV 格式"""
    channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    data_size = len(pcm_data)

    wav_header = b'RIFF'
    wav_header += struct.pack('<I', 36 + data_size)
    wav_header += b'WAVE'
    wav_header += b'fmt '
    wav_header += struct.pack('<I', 16)
    wav_header += struct.pack('<H', 1)
    wav_header += struct.pack('<H', channels)
    wav_header += struct.pack('<I', sample_rate)
    wav_header += struct.pack('<I', byte_rate)
    wav_header += struct.pack('<H', block_align)
    wav_header += struct.pack('<H', bits_per_sample)
    wav_header += b'data'
    wav_header += struct.pack('<I', data_size)

    return wav_header + pcm_data


def validate_text_length(text: str) -> str:
    """验证文本长度，中文最多150字，英文最多500字母"""
    chinese_chars = len(re.findall(r'[\u4e00-\u9fff]', text))
    english_letters = len(re.findall(r'[a-zA-Z]', text))

    if chinese_chars > 150:
        raise ValueError(f"中文超出限制：{chinese_chars}字（最多150字）")
    if english_letters > 500:
        raise ValueError(f"英文超出限制：{english_letters}字母（最多500字母）")

    return text


def text_to_speech(
    text: str,
    output_path: str,
    secret_id: Optional[str] = None,
    secret_key: Optional[str] = None,
    region: str = "ap-beijing",
    voice_type: int = 502003,
    fast_voice_type: Optional[str] = None,
    speed: Optional[int] = None,
    primary_language: Optional[int] = None,
    volume: Optional[int] = None
) -> str:
    """调用腾讯云 TTS API 合成语音
    
    Args:
        text: 要合成的文本
        output_path: 输出 WAV 文件路径
        secret_id: 腾讯云 Secret ID
        secret_key: 腾讯云 Secret Key
        region: 地域 (默认 ap-beijing)
        voice_type: 音色类型 (默认 502003)
        fast_voice_type: 一句话版声音复刻音色ID (克隆音色时填写)
        speed: 语速 (-2到6)
        primary_language: 主语言类型 (1=中文，2=英文)
        volume: 音量 (-10到10)
    """
    # 从环境变量读取凭证
    secret_id = secret_id or os.environ.get("TENCENT_SECRET_ID")
    secret_key = secret_key or os.environ.get("TENCENT_SECRET_KEY")

    if not secret_id or not secret_key:
        raise ValueError("缺少腾讯云凭证，请设置环境变量 TENCENT_SECRET_ID 和 TENCENT_SECRET_KEY")

    if not text.strip():
        raise ValueError("合成文本不能为空")

    validate_text_length(text.strip())

    # 读取配置
    if speed is None:
        speed = int(os.environ.get("TENCENT_TTS_SPEED", "0"))
    if primary_language is None:
        primary_language = int(os.environ.get("TENCENT_TTS_LANGUAGE", "1"))
    if volume is None:
        volume = int(os.environ.get("TENCENT_TTS_VOLUME", "0"))

    # 构建请求
    cred = credential.Credential(secret_id, secret_key)
    client = tts_client.TtsClient(cred, region)

    req = models.TextToVoiceRequest()
    req.Text = text.strip()
    req.ModelType = 1
    req.VoiceType = voice_type
    req.Codec = "pcm"
    req.SessionId = str(uuid.uuid4())
    req.SampleRate = 24000
    req.Speed = speed
    req.PrimaryLanguage = primary_language
    req.Volume = volume

    # 如果使用一句话版声音复刻，添加 FastVoiceType
    if fast_voice_type:
        req.FastVoiceType = fast_voice_type

    # 调用 API
    resp = client.TextToVoice(req)
    pcm_data = base64.b64decode(resp.Audio)
    wav_data = pcm_to_wav(pcm_data, sample_rate=24000)

    # 写入文件
    output_path = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    with open(output_path, "wb") as f:
        f.write(wav_data)

    return output_path


def main():
    """命令行入口"""
    if len(sys.argv) < 3:
        print("用法: python3 tts.py <文本> <输出文件.wav>", file=sys.stderr)
        print("", file=sys.stderr)
        print("环境变量:", file=sys.stderr)
        print("  TENCENT_SECRET_ID          - 腾讯云 Secret ID", file=sys.stderr)
        print("  TENCENT_SECRET_KEY         - 腾讯云 Secret Key", file=sys.stderr)
        print("  TENCENT_REGION             - 地域 (默认: ap-beijing)", file=sys.stderr)
        print("  TENCENT_VOICE_TYPE         - 音色类型 (默认: 502003)", file=sys.stderr)
        print("  TENCENT_FAST_VOICE_TYPE    - 一句话版声音复刻音色ID (克隆音色用，设置后会忽略 TENCENT_VOICE_TYPE)", file=sys.stderr)
        print("  TENCENT_TTS_SPEED          - 语速 (默认: 0)", file=sys.stderr)
        print("  TENCENT_TTS_LANGUAGE       - 语言 (默认: 1=中文)", file=sys.stderr)
        print("  TENCENT_TTS_VOLUME         - 音量 (默认: 0)", file=sys.stderr)
        print("", file=sys.stderr)
        print("示例:", file=sys.stderr)
        print("  # 使用预设音色", file=sys.stderr)
        print("  tts.py \"你好\" /tmp/out.wav", file=sys.stderr)
        print("", file=sys.stderr)
        print("  # 使用克隆音色（推荐）", file=sys.stderr)
        print("  TENCENT_FAST_VOICE_TYPE=xxx tts.py \"你好\" /tmp/out.wav", file=sys.stderr)
        sys.exit(1)

    text = sys.argv[1]
    output_path = sys.argv[2]

    # 从环境变量读取配置
    region = os.environ.get("TENCENT_REGION", "ap-beijing")
    voice_type = int(os.environ.get("TENCENT_VOICE_TYPE", "502003"))
    fast_voice_type = os.environ.get("TENCENT_FAST_VOICE_TYPE")
    speed = int(os.environ.get("TENCENT_TTS_SPEED", "0"))
    primary_language = int(os.environ.get("TENCENT_TTS_LANGUAGE", "1"))
    volume = int(os.environ.get("TENCENT_TTS_VOLUME", "0"))

    # 如果使用克隆音色，强制设置 VoiceType 为 200000000
    if fast_voice_type:
        voice_type = 200000000

    try:
        result_path = text_to_speech(
            text=text,
            output_path=output_path,
            region=region,
            voice_type=voice_type,
            fast_voice_type=fast_voice_type,
            speed=speed,
            primary_language=primary_language,
            volume=volume
        )
        print(result_path)
    except ValueError as e:
        print(f"参数错误: {e}", file=sys.stderr)
        sys.exit(1)
    except TencentCloudSDKException as e:
        print(f"API 调用失败: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"未知错误: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
