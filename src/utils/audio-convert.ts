import * as fs from "node:fs";
import * as path from "node:path";
import { decode, isSilk } from "silk-wasm";

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
 */
export function isVoiceAttachment(att: { content_type?: string; filename?: string }): boolean {
  if (att.content_type === "voice" || att.content_type?.startsWith("audio/")) {
    return true;
  }
  const ext = att.filename ? path.extname(att.filename).toLowerCase() : "";
  return [".amr", ".silk", ".slk"].includes(ext);
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
