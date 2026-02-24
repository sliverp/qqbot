/**
 * 文件下载工具
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * 生成安全的随机 ID
 */
function generateFileId(): string {
  return crypto.randomBytes(16).toString("hex");
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
    // 确保目录存在
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // 下载文件
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[download] Download failed: ${response.status} ${response.statusText}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    
    // 确定文件名
    let finalFilename: string;
    if (originalFilename) {
      const ext = path.extname(originalFilename);
      const baseName = path.basename(originalFilename, ext);
      const timestamp = Date.now();
      finalFilename = `${baseName}_${timestamp}${ext}`;
    } else {
      finalFilename = `${generateFileId()}.bin`;
    }
    
    const filePath = path.join(destDir, finalFilename);

    // 保存文件
    fs.writeFileSync(filePath, buffer);
    console.log(`[download] Downloaded file: ${filePath}`);
    
    return filePath;
  } catch (err) {
    console.error(`[download] Download error:`, err);
    return null;
  }
}
