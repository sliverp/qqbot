import * as fs from "node:fs";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { decode, encode, isSilk, isWav, getWavFileInfo } from "silk-wasm";

/**
 * 检查文件是否为 SILK 格式（QQ/微信语音常用格式）
 * QQ 语音文件通常以 .amr 扩展名保存，但实际编码可能是 SILK v3
 * SILK 文件头部标识: 0x02 "#!SILK_V3"
 */
function isSilkFile(filePath: string): boolean {
  try {
    const buf = fs.readFileSync(filePath);
    return isSilk(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  } catch {
    return false;
  }
}

/**
 * 将 PCM (s16le) 数据封装为 WAV 文件格式
 * WAV = 44 字节 RIFF 头 + PCM 原始数据
 */
function pcmToWav(pcmData: Uint8Array, sampleRate: number, channels: number = 1, bitsPerSample: number = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const headerSize = 44;
  const fileSize = headerSize + dataSize;

  const buffer = Buffer.alloc(fileSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write("WAVE", 8);

  // fmt sub-chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);         // sub-chunk size
  buffer.writeUInt16LE(1, 20);          // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength).copy(buffer, headerSize);

  return buffer;
}

/**
 * 去除 QQ 语音文件的 AMR 头（如果存在）
 * QQ 的 .amr 文件可能在 SILK 数据前有 "#!AMR\n" 头（6 字节）
 * 需要去除后才能被 silk-wasm 正确解码
 */
function stripAmrHeader(buf: Buffer): Buffer {
  const AMR_HEADER = Buffer.from("#!AMR\n");
  if (buf.length > 6 && buf.subarray(0, 6).equals(AMR_HEADER)) {
    return buf.subarray(6);
  }
  return buf;
}

/**
 * 将 SILK/AMR 语音文件转换为 WAV 格式
 *
 * @param inputPath 输入文件路径（.amr / .silk / .slk）
 * @param outputDir 输出目录（默认与输入文件同目录）
 * @returns 转换后的 WAV 文件路径，失败返回 null
 */
export async function convertSilkToWav(
  inputPath: string,
  outputDir?: string,
): Promise<{ wavPath: string; duration: number } | null> {
  if (!fs.existsSync(inputPath)) {
    return null;
  }

  const fileBuf = fs.readFileSync(inputPath);

  // 去除可能的 AMR 头
  const strippedBuf = stripAmrHeader(fileBuf);

  // 转为 Uint8Array 以兼容 silk-wasm 类型要求
  const rawData = new Uint8Array(strippedBuf.buffer, strippedBuf.byteOffset, strippedBuf.byteLength);

  // 验证是否为 SILK 格式
  if (!isSilk(rawData)) {
    return null;
  }

  // SILK 解码为 PCM (s16le)
  // QQ 语音通常采样率为 24000Hz
  const sampleRate = 24000;
  const result = await decode(rawData, sampleRate);

  // PCM → WAV
  const wavBuffer = pcmToWav(result.data, sampleRate);

  // 写入 WAV 文件
  const dir = outputDir || path.dirname(inputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const wavPath = path.join(dir, `${baseName}.wav`);
  fs.writeFileSync(wavPath, wavBuffer);

  return { wavPath, duration: result.duration };
}

/**
 * 判断是否为语音附件（根据 content_type 或文件扩展名）
 * QQ Bot 语音消息的 content_type 通常为 "voice"
 */
export function isVoiceAttachment(att: { content_type?: string; filename?: string }): boolean {
  // QQ Bot 语音消息的 content_type 是 "voice" 而不是 "audio/*"
  if (att.content_type === "voice" || att.content_type?.startsWith("audio/")) {
    return true;
  }
  // 根据文件扩展名判断
  const ext = att.filename ? path.extname(att.filename).toLowerCase() : "";
  return [".amr", ".silk", ".slk", ".mp3", ".wav", ".ogg"].includes(ext);
}

/**
 * 判断是否为视频附件（根据 content_type 或文件扩展名）
 * QQ Bot 视频消息的 content_type 通常为 "video" 或 "video/mp4"
 */
export function isVideoAttachment(att: { content_type?: string; filename?: string }): boolean {
  if (att.content_type === "video" || att.content_type?.startsWith("video/")) {
    return true;
  }
  const ext = att.filename ? path.extname(att.filename).toLowerCase() : "";
  return [".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv"].includes(ext);
}

/**
 * 判断是否为图片附件（根据 content_type 或文件扩展名）
 */
export function isImageAttachment(att: { content_type?: string; filename?: string }): boolean {
  if (att.content_type?.startsWith("image/")) {
    return true;
  }
  const ext = att.filename ? path.extname(att.filename).toLowerCase() : "";
  return [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext);
}

/**
 * 格式化语音时长为可读字符串
 */
export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return remainSeconds > 0 ? `${minutes}分${remainSeconds}秒` : `${minutes}分钟`;
}

/**
 * 检查 ffmpeg 是否可用
 */
let ffmpegAvailable: boolean | null = null;

export function isFfmpegAvailable(): boolean {
  if (ffmpegAvailable !== null) {
    return ffmpegAvailable;
  }
  
  try {
    const result = childProcess.spawnSync("ffmpeg", ["-version"], {
      timeout: 5000,
      stdio: "pipe",
    });
    ffmpegAvailable = result.status === 0;
  } catch {
    ffmpegAvailable = false;
  }
  
  return ffmpegAvailable;
}

/**
 * 需要转换为 SILK 的音频格式
 */
const SILK_NEEDED_EXTENSIONS = [".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".wma"];

/**
 * 判断文件是否需要转换为 SILK
 * @param filePath 文件路径
 * @returns true 表示需要转换
 */
export function needsSilkConversion(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  
  // 已经是 SILK 格式，不需要转换
  if ([".silk", ".slk", ".amr"].includes(ext)) {
    return false;
  }
  
  // 检查是否是 SILK 文件（即使扩展名不是 .silk）
  if (fs.existsSync(filePath)) {
    try {
      const buf = fs.readFileSync(filePath);
      if (isSilk(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))) {
        return false;
      }
    } catch {
      // 忽略错误
    }
  }
  
  return SILK_NEEDED_EXTENSIONS.includes(ext);
}

/**
 * 将 WAV 文件编码为 SILK 格式
 * @param inputPath 输入 WAV 文件路径
 * @param outputDir 输出目录（默认与输入文件同目录）
 * @returns 转换后的 SILK 文件路径和时长
 */
export async function encodeWavToSilk(
  inputPath: string,
  outputDir?: string,
): Promise<{ silkPath: string; duration: number } | null> {
  if (!fs.existsSync(inputPath)) {
    return null;
  }

  const fileBuf = fs.readFileSync(inputPath);
  const rawData = new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.length);

  // 验证是否为 WAV 格式
  if (!isWav(rawData)) {
    return null;
  }

  // 获取 WAV 文件信息
  const wavInfo = getWavFileInfo(rawData);
  
  // 编码为 SILK（采样率从 WAV 文件中获取）
  const result = await encode(rawData, wavInfo.fmt.sampleRate);

  // 写入 SILK 文件
  const dir = outputDir || path.dirname(inputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const silkPath = path.join(dir, `${baseName}.silk`);
  fs.writeFileSync(silkPath, result.data);

  return { silkPath, duration: result.duration };
}

/**
 * 将任意音频格式转换为 SILK（使用 ffmpeg）
 * 支持格式：mp3, wav, ogg, flac, aac, m4a, wma 等
 * 
 * @param inputPath 输入音频文件路径
 * @param outputDir 输出目录（默认与输入文件同目录）
 * @returns 转换后的 SILK 文件路径和时长
 */
export async function convertAudioToSilk(
  inputPath: string,
  outputDir?: string,
): Promise<{ silkPath: string; duration: number } | null> {
  if (!fs.existsSync(inputPath)) {
    return null;
  }

  const ext = path.extname(inputPath).toLowerCase();

  // 如果已经是 SILK 格式，直接返回
  if ([".silk", ".slk", ".amr"].includes(ext)) {
    const buf = fs.readFileSync(inputPath);
    const rawData = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
    
    if (isSilk(rawData)) {
      // 计算 SILK 时长
      const { getDuration } = await import("silk-wasm");
      const duration = getDuration(rawData);
      return { silkPath: inputPath, duration };
    }
  }

  // 如果是 WAV 格式，直接编码
  if (ext === ".wav") {
    const buf = fs.readFileSync(inputPath);
    const rawData = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
    
    if (isWav(rawData)) {
      return encodeWavToSilk(inputPath, outputDir);
    }
  }

  // 其他格式需要 ffmpeg 转换
  if (!isFfmpegAvailable()) {
    console.error("[audio-convert] ffmpeg not available, cannot convert non-WAV audio to SILK");
    return null;
  }

  // 使用 ffmpeg 转换为 PCM (s16le, 24000Hz, 单声道)
  // QQ 语音推荐采样率为 24000Hz
  const targetSampleRate = 24000;
  
  const dir = outputDir || path.dirname(inputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const pcmPath = path.join(dir, `${baseName}.pcm`);
  const silkPath = path.join(dir, `${baseName}.silk`);

  try {
    // 使用 ffmpeg 转换为 PCM
    const ffmpegResult = childProcess.spawnSync(
      "ffmpeg",
      [
        "-y",                    // 覆盖输出文件
        "-i", inputPath,         // 输入文件
        "-ar", String(targetSampleRate),  // 采样率
        "-ac", "1",              // 单声道
        "-f", "s16le",           // PCM 格式
        pcmPath,
      ],
      {
        timeout: 60000,          // 60秒超时
        stdio: "pipe",
      },
    );

    if (ffmpegResult.status !== 0) {
      console.error(`[audio-convert] ffmpeg failed: ${ffmpegResult.stderr?.toString()}`);
      return null;
    }

    // 读取 PCM 数据
    const pcmData = fs.readFileSync(pcmPath);
    const rawPcm = new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.length);

    // 编码为 SILK
    const result = await encode(rawPcm, targetSampleRate);

    // 写入 SILK 文件
    fs.writeFileSync(silkPath, result.data);

    // 清理临时 PCM 文件
    try {
      fs.unlinkSync(pcmPath);
    } catch {
      // 忽略清理错误
    }

    return { silkPath, duration: result.duration };
  } catch (err) {
    console.error(`[audio-convert] Failed to convert audio to SILK: ${err}`);
    return null;
  }
}

/**
 * 将音频数据（Buffer）转换为 SILK 格式
 * 支持格式：WAV, PCM, 以及需要 ffmpeg 的格式
 * 
 * @param audioData 音频数据
 * @param format 音频格式（wav, mp3, pcm 等）
 * @param sampleRate 采样率（PCM 格式需要指定，WAV 可自动检测）
 * @returns SILK 数据和时长
 */
export async function convertAudioDataToSilk(
  audioData: Buffer,
  format: string,
  sampleRate?: number,
): Promise<{ data: Uint8Array; duration: number } | null> {
  const rawData = new Uint8Array(audioData.buffer, audioData.byteOffset, audioData.length);

  // 如果已经是 SILK 格式
  if (isSilk(rawData)) {
    const { getDuration } = await import("silk-wasm");
    const duration = getDuration(rawData);
    return { data: rawData, duration };
  }

  // 如果是 WAV 格式
  if (format === "wav" || isWav(rawData)) {
    const wavInfo = getWavFileInfo(rawData);
    const result = await encode(rawData, wavInfo.fmt.sampleRate);
    return { data: result.data, duration: result.duration };
  }

  // 如果是 PCM 格式
  if (format === "pcm" && sampleRate) {
    const result = await encode(rawData, sampleRate);
    return { data: result.data, duration: result.duration };
  }

  // 其他格式需要写入临时文件，用 ffmpeg 转换
  if (!isFfmpegAvailable()) {
    console.error("[audio-convert] ffmpeg not available for format:", format);
    return null;
  }

  const tmpDir = path.join(process.env.TMP || process.env.TEMP || "/tmp", "qqbot-audio");
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const tmpInput = path.join(tmpDir, `input.${format}`);
  const tmpPcm = path.join(tmpDir, "output.pcm");

  try {
    // 写入临时输入文件
    fs.writeFileSync(tmpInput, audioData);

    // 使用 ffmpeg 转换为 PCM
    const targetSampleRate = 24000;
    const ffmpegResult = childProcess.spawnSync(
      "ffmpeg",
      [
        "-y",
        "-i", tmpInput,
        "-ar", String(targetSampleRate),
        "-ac", "1",
        "-f", "s16le",
        tmpPcm,
      ],
      {
        timeout: 60000,
        stdio: "pipe",
      },
    );

    if (ffmpegResult.status !== 0) {
      console.error(`[audio-convert] ffmpeg failed: ${ffmpegResult.stderr?.toString()}`);
      return null;
    }

    // 读取 PCM 并编码为 SILK
    const pcmData = fs.readFileSync(tmpPcm);
    const rawPcm = new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.length);
    const result = await encode(rawPcm, targetSampleRate);

    return { data: result.data, duration: result.duration };
  } catch (err) {
    console.error(`[audio-convert] Failed to convert audio data: ${err}`);
    return null;
  } finally {
    // 清理临时文件
    try {
      if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
      if (fs.existsSync(tmpPcm)) fs.unlinkSync(tmpPcm);
    } catch {
      // 忽略清理错误
    }
  }
}
