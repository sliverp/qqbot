/**
 * <qqimg> 标签解析工具
 * 将 AI 输出中的 <qqimg>路径</qqimg> 标签解析为发送队列
 */

/** 发送队列项 */
export interface SendQueueItem {
  type: "text" | "image";
  content: string;
}

/** qqimg 标签正则（支持 </qqimg> 和 </img> 两种闭合） */
const QQIMG_REGEX = /<qqimg>([^<>]+)<\/(?:qqimg|img)>/gi;

/**
 * 检测文本是否包含 <qqimg> 标签
 */
export function hasQqimgTags(text: string): boolean {
  QQIMG_REGEX.lastIndex = 0;
  return QQIMG_REGEX.test(text);
}

/**
 * 将包含 <qqimg> 标签的文本解析为发送队列
 * 按照文本中的出现顺序生成 text/image 交替队列
 *
 * @param text 包含 <qqimg> 标签的文本
 * @param textTransform 可选的文本转换函数（如过滤内部标记）
 * @returns 发送队列
 */
export function parseQqimgToSendQueue(
  text: string,
  textTransform?: (t: string) => string,
): SendQueueItem[] {
  const queue: SendQueueItem[] = [];
  const regex = /<qqimg>([^<>]+)<\/(?:qqimg|img)>/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // 标签前的文本
    const before = text.slice(lastIndex, match.index).replace(/\n{3,}/g, "\n\n").trim();
    if (before) {
      queue.push({ type: "text", content: textTransform ? textTransform(before) : before });
    }

    // 图片
    const imagePath = match[1]?.trim();
    if (imagePath) {
      queue.push({ type: "image", content: imagePath });
    }

    lastIndex = match.index + match[0].length;
  }

  // 最后一段文本
  const after = text.slice(lastIndex).replace(/\n{3,}/g, "\n\n").trim();
  if (after) {
    queue.push({ type: "text", content: textTransform ? textTransform(after) : after });
  }

  return queue;
}
