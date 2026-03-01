/**
 * VOICE 语音标记处理的公共模块
 * 用于处理 AI 回复中的 [VOICE:text="..."] 标记
 */

import path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "child_process";

export interface VoiceHandlerOptions {
  text: string;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
  // 发送语音的回调函数
  // voiceData: base64 编码的 SILK 音频数据（带 data:audio/silk;base64, 前缀）
  // duration: 语音时长（毫秒）
  sendVoice: (voiceData: string, duration: number) => Promise<void>;
  // 可选：是否需要将 WAV 转换为 SILK（默认 false）
  // gateway.ts 需要 SILK 转换，outbound.ts 直接发送 WAV
  needsSilkConversion?: boolean;
  // 可选：WAV 转 SILK 的转换函数（当 needsSilkConversion=true 时需要）
  convertToSilk?: (wavPath: string) => Promise<{ silkPath: string; duration: number } | null>;
}

export interface VoiceHandlerResult {
  textWithoutVoice: string; // 去掉 VOICE 标记后的文本
  voiceSent: boolean; // 是否成功发送语音
  error?: string; // 错误信息
}

/**
 * 处理文本中的 [VOICE:text="..."] 标记
 * 
 * 流程：
 * 1. 检测 VOICE 标记
 * 2. 调用 TTS 脚本生成 WAV
 * 3. 可选的 WAV → SILK 转换
 * 4. 通过回调发送语音
 * 5. 清理临时文件
 * 
 * @param options 配置选项
 * @returns 处理结果
 */
export async function handleVoiceMarker(
  options: VoiceHandlerOptions
): Promise<VoiceHandlerResult> {
  const { text, log, sendVoice, needsSilkConversion = false, convertToSilk } = options;

  // 默认日志函数
  const logger = log || {
    info: (msg: string) => console.log(msg),
    error: (msg: string) => console.error(msg),
  };

  // 检测 [VOICE:text="..."] 标记
  const voiceRegex = /\[VOICE:text="(.+?)"\]/;
  const voiceMatch = text.match(voiceRegex);

  if (!voiceMatch) {
    // 没有 VOICE 标记，直接返回原文本
    return {
      textWithoutVoice: text,
      voiceSent: false,
    };
  }

  const voiceText = voiceMatch[1];
  logger.info(`Detected [VOICE] marker, text: "${voiceText}"`);

  let wavPath = "";
  let silkPath = "";

  try {
    // 1. 调用 TTS 生成音频
    // voice-handler.ts 在 src/utils/ 目录，所以需要 ../.. 到项目根目录
    const ttsScriptPath = path.join(
      __dirname,
      "..",
      "..",
      "skills/tencent-tts/scripts/tts.py"
    );
    wavPath = `/tmp/tts_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`;

    logger.info(`Calling TTS script: ${ttsScriptPath}`);

    // 前置检查：TTS 脚本是否存在
    if (!fs.existsSync(ttsScriptPath)) {
      throw new Error(`TTS script not found: ${ttsScriptPath}`);
    }

    // 使用 execFileSync 安全地传递参数（避免命令注入）
    execFileSync("python3", [ttsScriptPath, voiceText, wavPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "pipe",
      timeout: 30000, // 30秒超时
    });

    // 检查生成的音频文件是否存在
    if (!fs.existsSync(wavPath)) {
      throw new Error(`TTS output file not created: ${wavPath}`);
    }

    logger.info(`TTS generated WAV file: ${wavPath}`);

    // 2. 准备语音数据
    let voiceData: string;
    let duration: number;

    if (needsSilkConversion) {
      // 需要 SILK 转换（gateway.ts）
      if (!convertToSilk) {
        throw new Error("convertToSilk function is required when needsSilkConversion=true");
      }

      logger.info(`Converting WAV to SILK: ${wavPath}`);
      const convertResult = await convertToSilk(wavPath);

      if (!convertResult) {
        throw new Error("WAV to SILK conversion failed");
      }

      silkPath = convertResult.silkPath;
      duration = convertResult.duration;

      // 读取转换后的 SILK 文件
      const silkBuffer = fs.readFileSync(silkPath);
      const base64Data = silkBuffer.toString("base64");
      voiceData = `data:audio/silk;base64,${base64Data}`;

      logger.info(
        `WAV converted to SILK (duration: ${duration}ms, size: ${silkBuffer.length} bytes)`
      );
    } else {
      // 直接使用 WAV（outbound.ts）
      const wavBuffer = fs.readFileSync(wavPath);
      const base64Data = wavBuffer.toString("base64");
      voiceData = `data:audio/wav;base64,${base64Data}`;
      
      // WAV 文件的时长需要从文件中解析，这里简化处理
      // outbound.ts 实际上直接发送文件路径，不需要计算时长
      duration = 0;

      logger.info(`Using WAV file directly (size: ${wavBuffer.length} bytes)`);
    }

    // 3. 发送语音消息
    await sendVoice(voiceData, duration);
    logger.info(`Sent voice message (duration: ${duration}ms)`);

    // 4. 清理临时文件
    try {
      if (wavPath && fs.existsSync(wavPath)) {
        fs.unlinkSync(wavPath);
        logger.info(`Cleaned up temp WAV file: ${wavPath}`);
      }
      if (silkPath && fs.existsSync(silkPath)) {
        fs.unlinkSync(silkPath);
        logger.info(`Cleaned up temp SILK file: ${silkPath}`);
      }
    } catch (cleanupErr) {
      logger.error(`Failed to cleanup temp files: ${cleanupErr}`);
    }

    // 5. 返回去掉 VOICE 标记后的文本
    const textWithoutVoice = text.replace(voiceRegex, "").trim();

    return {
      textWithoutVoice,
      voiceSent: true,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`TTS or voice send failed: ${errMsg}`);

    // 清理临时文件（错误情况下也要清理）
    try {
      if (wavPath && fs.existsSync(wavPath)) {
        fs.unlinkSync(wavPath);
      }
      if (silkPath && fs.existsSync(silkPath)) {
        fs.unlinkSync(silkPath);
      }
    } catch (cleanupErr) {
      // 忽略清理错误
    }

    // TTS 失败时回退到文本回复
    const fallbackText = text.replace(voiceRegex, "").trim();

    return {
      textWithoutVoice: fallbackText,
      voiceSent: false,
      error: errMsg,
    };
  }
}
