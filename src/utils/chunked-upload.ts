/**
 * 大文件分片上传模块
 * 
 * 流程（对照序列图）：
 * 1. 申请上传 (upload_prepare) → 获取 upload_id + block_size + 分片预签名链接
 * 2. 并行上传所有分片：
 *    对于每个分片 i（并行执行，但分片内部串行）：
 *      a. 读取文件的第 i 块数据
 *      b. PUT 到预签名 URL (COS)
 *      c. 调用 upload_part_finish 通知开放平台分片 i 已完成
 * 3. 所有分片完成后，调用完成文件上传接口 → 获取 file_info
 * 
 * 注意：N 个分片之间是并行的，但每个分片的"上传 + 完成"是串行的。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import {
  type MediaFileType,
  type UploadPrepareResponse,
  type UploadPrepareHashes,
  type MediaUploadResponse,
  c2cUploadPrepare,
  c2cUploadPartFinish,
  c2cCompleteUpload,
  groupUploadPrepare,
  groupUploadPartFinish,
  groupCompleteUpload,
  getAccessToken,
} from "../api.js";
import { formatFileSize } from "./file-utils.js";

/** 分片上传并发控制：最多同时上传 N 个分片 */
const MAX_CONCURRENT_PARTS = 1;

/** 单个分片上传超时（毫秒）— 5 分钟，兼容低带宽场景 */
const PART_UPLOAD_TIMEOUT = 300_000;

/** 单个分片上传最大重试次数 */
const PART_UPLOAD_MAX_RETRIES = 2;

/** 分片上传进度回调 */
export interface ChunkedUploadProgress {
  /** 当前已完成分片数 */
  completedParts: number;
  /** 总分片数 */
  totalParts: number;
  /** 已上传字节数 */
  uploadedBytes: number;
  /** 总字节数 */
  totalBytes: number;
}

/** 分片上传选项 */
export interface ChunkedUploadOptions {
  /** 进度回调 */
  onProgress?: (progress: ChunkedUploadProgress) => void;
  /** 最大并发数（默认 2） */
  maxConcurrent?: number;
  /** 日志前缀 */
  logPrefix?: string;
}

/**
 * C2C 大文件分片上传
 * 
 * @param appId - 应用 ID
 * @param clientSecret - 应用密钥
 * @param userId - 用户 openid
 * @param filePath - 本地文件路径
 * @param fileType - 文件类型（1=图片, 2=视频, 3=语音, 4=文件）
 * @param options - 上传选项
 * @returns 上传结果（包含 file_info 可直接用于发送消息）
 */
export async function chunkedUploadC2C(
  appId: string,
  clientSecret: string,
  userId: string,
  filePath: string,
  fileType: MediaFileType,
  options?: ChunkedUploadOptions,
): Promise<MediaUploadResponse> {
  const prefix = options?.logPrefix ?? "[chunked-upload]";
  const maxConcurrent = options?.maxConcurrent ?? MAX_CONCURRENT_PARTS;

  // 1. 读取文件信息
  const stat = await fs.promises.stat(filePath);
  const fileSize = stat.size;
  const fileName = filePath.split(/[/\\]/).pop() ?? "file";

  console.log(`${prefix} Starting chunked upload: file=${fileName}, size=${formatFileSize(fileSize)}, type=${fileType}`);

  // 2. 计算文件哈希（md5, sha1, md5_10m）
  console.log(`${prefix} Computing file hashes...`);
  const hashes = await computeFileHashes(filePath, fileSize);
  console.log(`${prefix} File hashes: md5=${hashes.md5}, sha1=${hashes.sha1}, md5_10m=${hashes.md5_10m}`);

  // 3. 申请上传 → 获取 upload_id + block_size + 预签名链接
  const accessToken = await getAccessToken(appId, clientSecret);
  console.log(`${prefix} >>> Calling c2cUploadPrepare(fileType=${fileType}, fileName=${fileName}, fileSize=${fileSize}, md5=${hashes.md5}, sha1=${hashes.sha1}, md5_10m=${hashes.md5_10m})`);
  const prepareResp = await c2cUploadPrepare(accessToken, userId, fileType, fileName, fileSize, hashes);
  console.log(`${prefix} <<< c2cUploadPrepare response:`, JSON.stringify(prepareResp));
  const { upload_id, parts } = prepareResp;
  // QQ 开放平台返回的 block_size 可能是字符串，需要转为数字
  const block_size = Number(prepareResp.block_size);

  console.log(`${prefix} Upload prepared: upload_id=${upload_id}, block_size=${formatFileSize(block_size)}, parts=${parts.length}`);

  // 4. 并行上传所有分片（带并发控制）
  let completedParts = 0;
  let uploadedBytes = 0;

  const uploadPart = async (part: { index: number; presigned_url: string }): Promise<void> => {
    const partIndex = part.index; // API 返回的 1-based index
    const partNum = partIndex; // 显示用序号（与 API 一致）
    // 计算本分片在文件中的偏移和长度（index 是 1-based，需要减 1）
    const offset = (partIndex - 1) * block_size;
    const length = Math.min(block_size, fileSize - offset);

    // 读取分片数据
    const partBuffer = await readFileChunk(filePath, offset, length);

    // 计算 MD5
    const md5Hex = crypto.createHash("md5").update(partBuffer).digest("hex");

    console.log(`${prefix} Part ${partNum}/${parts.length}: uploading ${formatFileSize(length)} (offset=${offset}, md5=${md5Hex})`);

    // a. PUT 到预签名 URL（带重试）
    await putToPresignedUrl(part.presigned_url, partBuffer, prefix, partNum, parts.length);

    // b. 通知开放平台分片上传完成（需要重新获取 token，避免长时间上传后 token 过期）
    const token = await getAccessToken(appId, clientSecret);
    console.log(`${prefix} >>> Calling c2cUploadPartFinish(upload_id=${upload_id}, partIndex=${partIndex}, blockSize=${length}, md5=${md5Hex})`);
    await c2cUploadPartFinish(token, userId, upload_id, partIndex, length, md5Hex);
    console.log(`${prefix} <<< c2cUploadPartFinish(partIndex=${partIndex}) done`);

    // 更新进度
    completedParts++;
    uploadedBytes += length;
    console.log(`${prefix} Part ${partNum}/${parts.length}: completed (${completedParts}/${parts.length})`);

    if (options?.onProgress) {
      options.onProgress({
        completedParts,
        totalParts: parts.length,
        uploadedBytes,
        totalBytes: fileSize,
      });
    }
  };

  // 并发控制：同时最多执行 maxConcurrent 个分片上传
  await runWithConcurrency(
    parts.map(part => () => uploadPart(part)),
    maxConcurrent,
  );

  console.log(`${prefix} All ${parts.length} parts uploaded successfully, completing upload...`);

  // 5. 完成文件上传
  const finalToken = await getAccessToken(appId, clientSecret);
  console.log(`${prefix} >>> Calling c2cCompleteUpload(upload_id=${upload_id})`);
  const result = await c2cCompleteUpload(finalToken, userId, upload_id);
  console.log(`${prefix} <<< c2cCompleteUpload response:`, JSON.stringify(result));

  console.log(`${prefix} Upload completed: file_uuid=${result.file_uuid}, ttl=${result.ttl}s`);

  return result;
}

/**
 * Group 大文件分片上传
 * 
 * @param appId - 应用 ID
 * @param clientSecret - 应用密钥
 * @param groupId - 群 openid
 * @param filePath - 本地文件路径
 * @param fileType - 文件类型（1=图片, 2=视频, 3=语音, 4=文件）
 * @param options - 上传选项
 * @returns 上传结果（包含 file_info 可直接用于发送消息）
 */
export async function chunkedUploadGroup(
  appId: string,
  clientSecret: string,
  groupId: string,
  filePath: string,
  fileType: MediaFileType,
  options?: ChunkedUploadOptions,
): Promise<MediaUploadResponse> {
  const prefix = options?.logPrefix ?? "[chunked-upload]";
  const maxConcurrent = options?.maxConcurrent ?? MAX_CONCURRENT_PARTS;

  // 1. 读取文件信息
  const stat = await fs.promises.stat(filePath);
  const fileSize = stat.size;
  const fileName = filePath.split(/[/\\]/).pop() ?? "file";

  console.log(`${prefix} Starting chunked upload (group): file=${fileName}, size=${formatFileSize(fileSize)}, type=${fileType}`);

  // 2. 计算文件哈希（md5, sha1, md5_10m）
  console.log(`${prefix} Computing file hashes...`);
  const hashes = await computeFileHashes(filePath, fileSize);
  console.log(`${prefix} File hashes: md5=${hashes.md5}, sha1=${hashes.sha1}, md5_10m=${hashes.md5_10m}`);

  // 3. 申请上传
  const accessToken = await getAccessToken(appId, clientSecret);
  console.log(`${prefix} >>> Calling groupUploadPrepare(fileType=${fileType}, fileName=${fileName}, fileSize=${fileSize}, md5=${hashes.md5}, sha1=${hashes.sha1}, md5_10m=${hashes.md5_10m})`);
  const prepareResp = await groupUploadPrepare(accessToken, groupId, fileType, fileName, fileSize, hashes);
  console.log(`${prefix} <<< groupUploadPrepare response:`, JSON.stringify(prepareResp));
  const { upload_id, parts } = prepareResp;
  // QQ 开放平台返回的 block_size 可能是字符串，需要转为数字
  const block_size = Number(prepareResp.block_size);

  console.log(`${prefix} Upload prepared: upload_id=${upload_id}, block_size=${formatFileSize(block_size)}, parts=${parts.length}`);

  // 4. 并行上传所有分片（带并发控制）
  let completedParts = 0;
  let uploadedBytes = 0;

  const uploadPart = async (part: { index: number; presigned_url: string }): Promise<void> => {
    const partIndex = part.index; // API 返回的 1-based index
    const partNum = partIndex; // 显示用序号（与 API 一致）
    const offset = (partIndex - 1) * block_size;
    const length = Math.min(block_size, fileSize - offset);

    const partBuffer = await readFileChunk(filePath, offset, length);
    const md5Hex = crypto.createHash("md5").update(partBuffer).digest("hex");

    console.log(`${prefix} Part ${partNum}/${parts.length}: uploading ${formatFileSize(length)} (offset=${offset}, md5=${md5Hex})`);

    await putToPresignedUrl(part.presigned_url, partBuffer, prefix, partNum, parts.length);

    const token = await getAccessToken(appId, clientSecret);
    console.log(`${prefix} >>> Calling groupUploadPartFinish(upload_id=${upload_id}, partIndex=${partIndex}, blockSize=${length}, md5=${md5Hex})`);
    await groupUploadPartFinish(token, groupId, upload_id, partIndex, length, md5Hex);
    console.log(`${prefix} <<< groupUploadPartFinish(partIndex=${partIndex}) done`);

    completedParts++;
    uploadedBytes += length;
    console.log(`${prefix} Part ${partNum}/${parts.length}: completed (${completedParts}/${parts.length})`);

    if (options?.onProgress) {
      options.onProgress({
        completedParts,
        totalParts: parts.length,
        uploadedBytes,
        totalBytes: fileSize,
      });
    }
  };

  await runWithConcurrency(
    parts.map(part => () => uploadPart(part)),
    maxConcurrent,
  );

  console.log(`${prefix} All ${parts.length} parts uploaded successfully, completing upload...`);

  // 5. 完成文件上传
  const finalToken = await getAccessToken(appId, clientSecret);
  console.log(`${prefix} >>> Calling groupCompleteUpload(upload_id=${upload_id})`);
  const result = await groupCompleteUpload(finalToken, groupId, upload_id);
  console.log(`${prefix} <<< groupCompleteUpload response:`, JSON.stringify(result));

  console.log(`${prefix} Upload completed: file_uuid=${result.file_uuid}, ttl=${result.ttl}s`);

  return result;
}

/**
 * 读取文件的指定区间（分片）
 */
async function readFileChunk(filePath: string, offset: number, length: number): Promise<Buffer> {
  const fd = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buffer, 0, length, offset);
    if (bytesRead < length) {
      // 文件末尾，返回实际读取的部分
      return buffer.subarray(0, bytesRead);
    }
    return buffer;
  } finally {
    await fd.close();
  }
}

/**
 * PUT 分片数据到预签名 URL（带重试）
 */
async function putToPresignedUrl(
  presignedUrl: string,
  data: Buffer,
  prefix: string,
  partIndex: number,
  totalParts: number,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= PART_UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PART_UPLOAD_TIMEOUT);

      try {
        // 将 Buffer 转为标准 ArrayBuffer 再包装为 Blob，兼容 bun-types 类型定义
        const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

        const attemptLabel = attempt > 0 ? ` (retry ${attempt})` : "";
        console.log(`${prefix} >>> PUT Part ${partIndex}/${totalParts}${attemptLabel}: url=${presignedUrl}, size=${data.length}`);
        const startTime = Date.now();

        const response = await fetch(presignedUrl, {
          method: "PUT",
          body: new Blob([ab]),
          headers: {
            "Content-Length": String(data.length),
          },
          signal: controller.signal,
        });

        const elapsed = Date.now() - startTime;
        const etag = response.headers.get("ETag") ?? "-";
        const requestId = response.headers.get("x-cos-request-id") ?? "-";

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          console.error(`${prefix} <<< PUT Part ${partIndex}/${totalParts}: FAILED ${response.status} ${response.statusText} (${elapsed}ms, requestId=${requestId}) body=${body}`);
          throw new Error(`COS PUT failed: ${response.status} ${response.statusText} - ${body}`);
        }

        console.log(`${prefix} <<< PUT Part ${partIndex}/${totalParts}: ${response.status} OK (${elapsed}ms, ETag=${etag}, requestId=${requestId})`);
        return; // 成功
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      if (lastError.name === "AbortError") {
        lastError = new Error(`Part ${partIndex}/${totalParts} upload timeout after ${PART_UPLOAD_TIMEOUT}ms`);
      }

      if (attempt < PART_UPLOAD_MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`${prefix} Part ${partIndex}/${totalParts}: attempt ${attempt + 1} failed (${lastError.message}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

/**
 * 带并发限制的异步任务执行器（批次模式）
 * 每批最多执行 maxConcurrent 个任务，等全部完成后再启动下一批
 */
async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  maxConcurrent: number,
): Promise<void> {
  for (let i = 0; i < tasks.length; i += maxConcurrent) {
    const batch = tasks.slice(i, i + maxConcurrent);
    await Promise.all(batch.map(task => task()));
  }
}

// ============ 文件哈希计算 ============

/** 文件前 N 字节用于计算 md5_10m（与协议定义一致：10002432 Bytes） */
const MD5_10M_SIZE = 10002432;

/**
 * 流式计算文件的 MD5、SHA1、md5_10m（前 10002432 Bytes 的 MD5）
 * 只遍历文件一次，内存友好
 */
async function computeFileHashes(
  filePath: string,
  fileSize: number,
): Promise<UploadPrepareHashes> {
  return new Promise((resolve, reject) => {
    const md5Hash = crypto.createHash("md5");
    const sha1Hash = crypto.createHash("sha1");
    const md5_10mHash = crypto.createHash("md5");

    let bytesRead = 0;
    const need10m = fileSize > MD5_10M_SIZE; // 文件超过阈值才需要单独计算 md5_10m

    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk: Buffer | string) => {
      // ReadStream 默认 encoding=null，chunk 一定是 Buffer，但类型声明要求兼容 string
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      md5Hash.update(buf);
      sha1Hash.update(buf);

      if (need10m) {
        const remaining = MD5_10M_SIZE - bytesRead;
        if (remaining > 0) {
          md5_10mHash.update(remaining >= buf.length ? buf : buf.subarray(0, remaining));
        }
      }

      bytesRead += buf.length;
    });

    stream.on("end", () => {
      const md5 = md5Hash.digest("hex");
      const sha1 = sha1Hash.digest("hex");
      // 文件不足 MD5_10M_SIZE 时，md5_10m 等于整文件 MD5
      const md5_10m = need10m ? md5_10mHash.digest("hex") : md5;

      resolve({ md5, sha1, md5_10m });
    });

    stream.on("error", reject);
  });
}
