/**
 * MIME 类型工具
 * 集中管理文件扩展名和 MIME 类型的映射关系
 */

/** 图片格式 MIME 类型映射 */
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/**
 * 根据文件扩展名获取图片 MIME 类型
 * @param ext 文件扩展名（含点号，如 ".png"）
 * @returns MIME 类型字符串，未识别返回 null
 */
export function getImageMimeType(ext: string): string | null {
  return IMAGE_MIME_TYPES[ext.toLowerCase()] ?? null;
}

/**
 * 获取所有支持的图片扩展名
 */
export function getSupportedImageExtensions(): string[] {
  return Object.keys(IMAGE_MIME_TYPES);
}
