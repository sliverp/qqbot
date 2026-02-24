/**
 * 文本处理工具
 */

/**
 * 解析 QQ 表情标签
 * 将 <faceType=1,faceId="13",ext="base64..."> 替换为 【表情: 中文名】
 */
export function parseFaceTags(text: string): string {
  if (!text) return text;
  return text.replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_match, ext: string) => {
    try {
      const decoded = Buffer.from(ext, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      const faceName = parsed.text || "未知表情";
      return `【表情: ${faceName}】`;
    } catch {
      return _match;
    }
  });
}

/**
 * 过滤内部标记（如 [[reply_to: xxx]]）
 * 这些标记可能被 AI 错误地学习并输出
 */
export function filterInternalMarkers(text: string): string {
  if (!text) return text;
  let result = text.replace(/\[\[[a-z_]+:\s*[^\]]*\]\]/gi, "");
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}
