/**
 * 群历史消息缓存（对齐 Discord/WhatsApp 的 history 方案）
 *
 * 非@消息写入内存 Map，被@时一次性注入上下文后清空。
 * 自包含实现，不依赖 openclaw/plugin-sdk。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 历史上下文标记，与 Discord 侧保持一致 */
const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
/** 当前消息标记 */
const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";
/** 历史 Map 最大 key 数量（LRU 淘汰，防止无限增长） */
const MAX_HISTORY_KEYS = 1000;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 附件摘要（统一格式）
 *
 * 兼容 ref-index-store 的 RefAttachmentSummary、群历史缓存、以及 gateway 当前消息动态上下文。
 * 所有场景的附件描述都通过 formatAttachmentTags() 统一格式化，确保标签风格一致。
 */
export interface AttachmentSummary {
  /** 附件类型 */
  type: "image" | "voice" | "video" | "file" | "unknown";
  /** 文件名（如有） */
  filename?: string;
  /** 语音转录文本（入站：STT/ASR识别结果；出站：TTS原文本） */
  transcript?: string;
  /** 语音转录来源：stt=本地STT、asr=平台ASR、tts=TTS原文本、fallback=兜底文案 */
  transcriptSource?: "stt" | "asr" | "tts" | "fallback";
  /** 已下载到本地的文件路径 */
  localPath?: string;
  /** 在线来源 URL（公网图片/文件等） */
  url?: string;
}

/** @deprecated 使用 AttachmentSummary 代替 */
export type HistoryAttachment = AttachmentSummary;

export interface HistoryEntry {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
  /** 富媒体附件摘要（图片/语音/视频/文件） */
  attachments?: AttachmentSummary[];
}

// ---------------------------------------------------------------------------
// 附件标签格式化（全局统一）
// ---------------------------------------------------------------------------

/**
 * 将附件摘要格式化为统一的人类可读标签描述（供 AI 上下文注入）。
 *
 * 标签风格对齐 openclaw 框架的 MEDIA: 标签：
 *   有路径的附件  → MEDIA:path
 *   语音+转录    → MEDIA:path （内容: "transcript"）
 *   无路径的语音  → [语音消息（内容: "transcript"）]
 *   无路径无转录  → [图片] / [语音消息] / [视频] / [文件]
 *
 * 此函数是所有附件描述的 **唯一格式化入口**，确保引用消息、群历史缓存、
 * 当前消息动态上下文三处标签风格完全一致。
 */
export function formatAttachmentTags(attachments?: AttachmentSummary[]): string {
  if (!attachments?.length) return "";
  const parts: string[] = [];
  for (const att of attachments) {
    const source = att.localPath || att.url;
    if (source) {
      // 有路径：使用 MEDIA: 标签
      if (att.type === "voice" && att.transcript) {
        parts.push(`MEDIA:${source}（内容: "${att.transcript}"）`);
      } else {
        parts.push(`MEDIA:${source}`);
      }
    } else {
      // 无路径：使用描述性标签
      switch (att.type) {
        case "image":
          parts.push(`[图片${att.filename ? `: ${att.filename}` : ""}]`);
          break;
        case "voice":
          parts.push(att.transcript
            ? `[语音消息（内容: "${att.transcript}"）]`
            : "[语音消息]");
          break;
        case "video":
          parts.push(`[视频${att.filename ? `: ${att.filename}` : ""}]`);
          break;
        case "file":
          parts.push(`[文件${att.filename ? `: ${att.filename}` : ""}]`);
          break;
        default:
          parts.push(`[附件${att.filename ? `: ${att.filename}` : ""}]`);
      }
    }
  }
  return parts.join("\n");
}

/** @deprecated 使用 formatAttachmentTags 代替 */
export const formatHistoryAttachments = formatAttachmentTags;

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * LRU 淘汰：当 historyMap 的 key 数量超过阈值时，删除最早插入的 key。
 */
function evictOldHistoryKeys<T>(historyMap: Map<string, T[]>, maxKeys: number = MAX_HISTORY_KEYS): void {
  if (historyMap.size <= maxKeys) return;
  const keysToDelete = historyMap.size - maxKeys;
  const iterator = historyMap.keys();
  for (let i = 0; i < keysToDelete; i++) {
    const key = iterator.next().value;
    if (key !== undefined) {
      historyMap.delete(key);
    }
  }
}

/**
 * 向指定 key 的历史列表追加一条记录，超出 limit 时从头部淘汰。
 * 同时刷新 key 的插入顺序（Map 迭代顺序 = 插入顺序），实现 LRU 语义。
 */
function appendHistoryEntry(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  entry: HistoryEntry;
  limit: number;
}): HistoryEntry[] {
  const { historyMap, historyKey, entry } = params;
  if (params.limit <= 0) return [];

  const history = historyMap.get(historyKey) ?? [];
  history.push(entry);
  while (history.length > params.limit) {
    history.shift();
  }
  // 刷新插入顺序
  if (historyMap.has(historyKey)) {
    historyMap.delete(historyKey);
  }
  historyMap.set(historyKey, history);
  evictOldHistoryKeys(historyMap);
  return history;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 记录一条待注入的历史消息（非@消息调用此函数）。
 * limit <= 0 或 entry 为空时不记录。
 */
export function recordPendingHistoryEntry(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  entry?: HistoryEntry | null;
  limit: number;
}): HistoryEntry[] {
  if (!params.entry || params.limit <= 0) return [];
  return appendHistoryEntry({
    historyMap: params.historyMap,
    historyKey: params.historyKey,
    entry: params.entry,
    limit: params.limit,
  });
}

/**
 * 构建包含历史上下文的完整消息体（被@时调用）。
 * 如果没有累积的历史消息，直接返回 currentMessage 原文。
 */
export function buildPendingHistoryContext(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
}): string {
  if (params.limit <= 0) return params.currentMessage;

  const entries = params.historyMap.get(params.historyKey) ?? [];
  if (entries.length === 0) return params.currentMessage;

  const lineBreak = params.lineBreak ?? "\n";
  const historyText = entries.map(params.formatEntry).join(lineBreak);

  return [
    HISTORY_CONTEXT_MARKER,
    historyText,
    "",
    CURRENT_MESSAGE_MARKER,
    params.currentMessage,
  ].join(lineBreak);
}

/**
 * 清空指定群的历史缓存（回复完成后调用）。
 * limit <= 0 表示功能已禁用，不做操作。
 */
export function clearPendingHistory(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
}): void {
  if (params.limit <= 0) return;
  params.historyMap.set(params.historyKey, []);
}
