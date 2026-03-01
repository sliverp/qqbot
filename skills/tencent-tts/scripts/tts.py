#!/usr/bin/env python3
"""
腾讯云 TTS (Text-to-Speech) 语音合成工具
使用腾讯云 TextToVoice API 生成 WAV 格式语音文件
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
    """将 PCM 音频数据封装为 WAV 格式

    Args:
        pcm_data: 原始 PCM 音频数据
        sample_rate: 采样率，默认 24000 Hz (24kHz)

    Returns:
        WAV 格式的音频数据
    """
    channels = 1  # 单声道
    bits_per_sample = 16  # 16位采样
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    data_size = len(pcm_data)

    # RIFF 头
    wav_header = b'RIFF'
    wav_header += struct.pack('<I', 36 + data_size)  # 文件总大小 - 8
    wav_header += b'WAVE'

    # fmt 子块
    wav_header += b'fmt '
    wav_header += struct.pack('<I', 16)  # 子块大小
    wav_header += struct.pack('<H', 1)   # 音频格式 (1 = PCM)
    wav_header += struct.pack('<H', channels)  # 声道数
    wav_header += struct.pack('<I', sample_rate)  # 采样率
    wav_header += struct.pack('<I', byte_rate)    # 字节率
    wav_header += struct.pack('<H', block_align)  # 块对齐
    wav_header += struct.pack('<H', bits_per_sample)  # 采样位数

    # data 子块
    wav_header += b'data'
    wav_header += struct.pack('<I', data_size)  # 音频数据大小

    return wav_header + pcm_data


def validate_text_length(text: str) -> str:
    """验证文本长度，中文最多150字，英文最多500字母

    Args:
        text: 要验证的文本

    Returns:
        验证通过的文本

    Raises:
        ValueError: 文本超长
    """
    # 统计中文字符数
    chinese_chars = len(re.findall(r'[\u4e00-\u9fff]', text))
    # 统计英文字母数
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
    speed: Optional[int] = None,
    primary_language: Optional[int] = None,
    volume: Optional[int] = None
) -> str:
    """调用腾讯云 TTS API 合成语音

    Args:
        text: 要合成的文本
        output_path: 输出 WAV 文件路径
        secret_id: 腾讯云 Secret ID (默认从环境变量 TENCENT_SECRET_ID 读取)
        secret_key: 腾讯云 Secret Key (默认从环境变量 TENCENT_SECRET_KEY 读取)
        region: 地域 (默认 ap-beijing)
        voice_type: 音色类型 (默认 502003)
        speed: 语速 (-2到6，默认从环境变量 TENCENT_TTS_SPEED 读取，否则 0)
        primary_language: 主语言类型 (1=中文，2=英文，默认从环境变量 TENCENT_TTS_LANGUAGE 读取，否则 1)
        volume: 音量 (-10到10，默认从环境变量 TENCENT_TTS_VOLUME 读取，否则 0)

    Returns:
        生成的 WAV 文件绝对路径

    Raises:
        ValueError: 配置缺失或参数错误
        TencentCloudSDKException: API 调用失败
    """
    # 从环境变量读取凭证
    secret_id = secret_id or os.environ.get("TENCENT_SECRET_ID")
    secret_key = secret_key or os.environ.get("TENCENT_SECRET_KEY")

    if not secret_id or not secret_key:
        raise ValueError(
            "缺少腾讯云凭证，请设置环境变量 TENCENT_SECRET_ID 和 TENCENT_SECRET_KEY"
        )

    if not text.strip():
        raise ValueError("合成文本不能为空")

    # 验证文本长度
    validate_text_length(text.strip())

    # 读取语速配置
    if speed is None:
        speed = int(os.environ.get("TENCENT_TTS_SPEED", "0"))

    # 读取主语言配置
    if primary_language is None:
        primary_language = int(os.environ.get("TENCENT_TTS_LANGUAGE", "1"))

    # 读取音量配置
    if volume is None:
        volume = int(os.environ.get("TENCENT_TTS_VOLUME", "0"))

    # 构建请求
    cred = credential.Credential(secret_id, secret_key)
    client = tts_client.TtsClient(cred, region)

    req = models.TextToVoiceRequest()
    req.Text = text.strip()
    req.ModelType = 1  # 基础版
    req.VoiceType = voice_type
    req.Codec = "pcm"  # 输出 PCM 格式，我们自行封装 WAV
    req.SessionId = str(uuid.uuid4())  # 必选：会话ID
    req.SampleRate = 24000  # 采样率 24kHz
    req.Speed = speed  # 语速
    req.PrimaryLanguage = primary_language  # 主语言
    req.Volume = volume  # 音量

    # 调用 API
    resp = client.TextToVoice(req)

    # 获取音频数据 (Base64 解码)
    pcm_data = base64.b64decode(resp.Audio)

    # 转换为 WAV 格式
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
        sys.exit(1)

    text = sys.argv[1]
    output_path = sys.argv[2]

    # 从环境变量读取配置
    region = os.environ.get("TENCENT_REGION", "ap-beijing")
    voice_type = int(os.environ.get("TENCENT_VOICE_TYPE", "502003"))
    speed = int(os.environ.get("TENCENT_TTS_SPEED", "0"))
    primary_language = int(os.environ.get("TENCENT_TTS_LANGUAGE", "1"))
    volume = int(os.environ.get("TENCENT_TTS_VOLUME", "0"))

    try:
        result_path = text_to_speech(
            text=text,
            output_path=output_path,
            region=region,
            voice_type=voice_type,
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
