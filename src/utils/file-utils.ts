/**
 * 文件操作工具 — 异步读取 + 大小校验 + 进度提示 + 下载
 */

import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";

/** QQ Bot API 最大上传文件大小：20MB */
export const MAX_UPLOAD_SIZE = 20 * 1024 * 1024;

/** 大文件阈值（超过此值发送进度提示）：5MB */
export const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024;

/**
 * 文件大小校验结果
 */
export interface FileSizeCheckResult {
  ok: boolean;
  size: number;
  error?: string;
}

/**
 * 校验文件大小是否在上传限制内
 * @param filePath 文件路径
 * @param maxSize 最大允许大小（字节），默认 20MB
 */
export function checkFileSize(filePath: string, maxSize = MAX_UPLOAD_SIZE): FileSizeCheckResult {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxSize) {
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      const limitMB = (maxSize / (1024 * 1024)).toFixed(0);
      return {
        ok: false,
        size: stat.size,
        error: `文件过大 (${sizeMB}MB)，QQ Bot API 上传限制为 ${limitMB}MB`,
      };
    }
    return { ok: true, size: stat.size };
  } catch (err) {
    return {
      ok: false,
      size: 0,
      error: `无法读取文件信息: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 异步读取文件内容
 * 替代 fs.readFileSync，避免阻塞事件循环
 */
export async function readFileAsync(filePath: string): Promise<Buffer> {
  return fs.promises.readFile(filePath);
}

/**
 * 异步检查文件是否存在
 */
export async function fileExistsAsync(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 异步获取文件大小
 */
export async function getFileSizeAsync(filePath: string): Promise<number> {
  const stat = await fs.promises.stat(filePath);
  return stat.size;
}

/**
 * 判断文件是否为"大文件"（需要进度提示）
 */
export function isLargeFile(sizeBytes: number): boolean {
  return sizeBytes >= LARGE_FILE_THRESHOLD;
}

/**
 * 格式化文件大小为人类可读的字符串
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 根据文件扩展名获取 MIME 类型
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".txt": "text/plain",
  };
  return mimeTypes[ext] ?? "application/octet-stream";
}

/**
 * 下载远程文件并保存到本地
 * @param url 远程文件 URL
 * @param destDir 目标目录
 * @param originalFilename 原始文件名（可选，完整文件名包含扩展名）
 * @returns 本地文件路径，失败返回 null
 */
export async function downloadFile(
  url: string,
  destDir: string,
  originalFilename?: string
): Promise<string | null> {
  try {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[file-utils] Download failed: ${response.status} ${response.statusText}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    let finalFilename: string;
    if (originalFilename) {
      let decodedFilename = originalFilename;
      try { decodedFilename = decodeURIComponent(originalFilename); } catch { /* keep original */ }
      const ext = path.extname(decodedFilename);
      const baseName = path.basename(decodedFilename, ext);
      const timestamp = Date.now();
      finalFilename = `${baseName}_${timestamp}${ext}`;
    } else {
      finalFilename = `${crypto.randomBytes(16).toString("hex")}.bin`;
    }

    const filePath = path.join(destDir, finalFilename);
    fs.writeFileSync(filePath, buffer);
    console.log(`[file-utils] Downloaded file: ${filePath}`);

    return filePath;
  } catch (err) {
    console.error(`[file-utils] Download error:`, err);
    return null;
  }
}
