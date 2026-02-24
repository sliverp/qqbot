/**
 * 图片 Base64 转换工具
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getImageMimeType, getSupportedImageExtensions } from "./mime.js";

export interface ImageConversionResult {
  dataUrl: string;
  sizeBytes: number;
  mimeType: string;
}

/**
 * 将本地图片文件转换为 Base64 Data URL
 * @param filePath 本地图片文件路径
 * @returns 转换结果，失败返回包含 error 的对象
 */
export function localImageToBase64(filePath: string): ImageConversionResult | { error: string } {
  if (!fs.existsSync(filePath)) {
    return { error: `图片文件不存在: ${filePath}` };
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeType = getImageMimeType(ext);
  if (!mimeType) {
    return {
      error: `不支持的图片格式: ${ext}。支持: ${getSupportedImageExtensions().join(", ")}`,
    };
  }

  const fileBuffer = fs.readFileSync(filePath);
  const base64Data = fileBuffer.toString("base64");

  return {
    dataUrl: `data:${mimeType};base64,${base64Data}`,
    sizeBytes: fileBuffer.length,
    mimeType,
  };
}

/**
 * 判断路径是否为本地文件路径
 */
export function isLocalPath(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p);
}

/**
 * 判断路径是否为 HTTP(S) URL
 */
export function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/**
 * 判断是否为 Base64 Data URL
 */
export function isDataUrl(url: string): boolean {
  return url.startsWith("data:");
}
