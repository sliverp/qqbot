/**
 * 出站消息投递模块
 *
 * 从 gateway deliver 回调中提取的两大发送管线：
 * 1. parseAndSendMediaTags — 解析 <qqimg/qqvoice/qqvideo/qqfile/qqmedia> 标签并按顺序发送
 * 2. sendPlainReply — 处理不含媒体标签的普通回复（markdown 图片/纯文本+图片）
 */

import type { ResolvedQQBotAccount } from "./types.js";
import { sendC2CMessage, sendGroupMessage, sendChannelMessage, sendC2CImageMessage, sendGroupImageMessage } from "./api.js";
import { sendPhoto, sendMedia as sendMediaAuto, type MediaTargetContext } from "./outbound.js";
import { chunkText, TEXT_CHUNK_LIMIT } from "./channel.js";
import { getQQBotRuntime } from "./runtime.js";
import { getImageSize, formatQQBotMarkdownImage, hasQQBotImageSize } from "./utils/image-size.js";
import { parseMediaTagsToSendQueue, executeSendQueue, type MediaSendContext } from "./utils/media-send.js";
import { isLocalPath as isLocalFilePath } from "./utils/platform.js";
import { filterInternalMarkers } from "./utils/text-parsing.js";

// ============ 类型定义 ============

export interface DeliverEventContext {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  messageId: string;
  channelId?: string;
  groupOpenid?: string;
  msgIdx?: string;
}

export interface DeliverAccountContext {
  account: ResolvedQQBotAccount;
  qualifiedTarget: string;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/** token 重试包装 */
export type SendWithRetryFn = <T>(sendFn: (token: string) => Promise<T>) => Promise<T>;

/** 一次性消费引用 ref */
export type ConsumeQuoteRefFn = () => string | undefined;

// ============ 1. 媒体标签解析 + 发送 ============

/**
 * 解析回复文本中的媒体标签并按顺序发送。
 *
 * @returns true 如果检测到媒体标签并已处理；false 表示无媒体标签，调用方继续走普通文本管线
 */
export async function parseAndSendMediaTags(
  replyText: string,
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
): Promise<{ handled: boolean; normalizedText: string }> {
  const { account, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;

  // 使用 media-send.ts 的统一解析器（内含 normalizeMediaTags + 路径编码修复）
  const { hasMediaTags: hasMedia, sendQueue } = parseMediaTagsToSendQueue(replyText, log);

  if (!hasMedia || sendQueue.length === 0) {
    return { handled: false, normalizedText: replyText };
  }

  log?.info(`${prefix} Send queue: ${sendQueue.map(item => item.type).join(" -> ")}`);

  // 构建统一的媒体发送上下文
  const mediaTarget: MediaTargetContext = {
    targetType: event.type === "c2c" ? "c2c" : event.type === "group" ? "group" : "channel",
    targetId: event.type === "c2c" ? event.senderId : event.type === "group" ? event.groupOpenid! : event.channelId!,
    account,
    replyToId: event.messageId,
    logPrefix: prefix,
  };

  const mediaSendCtx: MediaSendContext = {
    mediaTarget,
    qualifiedTarget: actx.qualifiedTarget,
    account,
    replyToId: event.messageId,
    log,
  };

  // 使用 media-send.ts 的统一执行器
  await executeSendQueue(sendQueue, mediaSendCtx, {
    onSendText: async (textContent) => {
      await sendTextChunks(filterInternalMarkers(textContent), event, actx, sendWithRetry, consumeQuoteRef);
    },
  });

  return { handled: true, normalizedText: replyText };
}

// ============ 2. 非结构化消息发送（普通文本 + 图片） ============

export interface PlainReplyPayload {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
}

/**
 * 发送不含媒体标签的普通回复。
 * 处理 markdown 图片嵌入、Base64 富媒体、纯文本分块、本地媒体自动路由。
 */
export async function sendPlainReply(
  payload: PlainReplyPayload,
  replyText: string,
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
  toolMediaUrls: string[],
): Promise<void> {
  const { account, qualifiedTarget, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;

  // 预去重：把 payload 自带的媒体 URL 从 toolMediaUrls 中移除，
  // 防止同一个文件既被 payload.mediaUrl/mediaUrls 发送，又被 toolMediaUrls 重复发送
  if (toolMediaUrls.length > 0) {
    const payloadUrls = new Set<string>();
    if (payload.mediaUrl) payloadUrls.add(payload.mediaUrl);
    if (payload.mediaUrls) for (const u of payload.mediaUrls) payloadUrls.add(u);
    if (payloadUrls.size > 0) {
      const before = toolMediaUrls.length;
      const filtered = toolMediaUrls.filter(url => !payloadUrls.has(url));
      if (filtered.length < before) {
        log?.info(`${prefix} Pre-dedup: removed ${before - filtered.length} payload media URL(s) from toolMediaUrls`);
        toolMediaUrls.length = 0;
        toolMediaUrls.push(...filtered);
      }
    }
  }

  const collectedImageUrls: string[] = [];
  const localMediaToSend: string[] = [];

  const collectImageUrl = (url: string | undefined | null): boolean => {
    if (!url) return false;
    const isHttpUrl = url.startsWith("http://") || url.startsWith("https://");
    const isDataUrl = url.startsWith("data:image/");
    if (isHttpUrl || isDataUrl) {
      if (!collectedImageUrls.includes(url)) {
        collectedImageUrls.push(url);
        log?.info(`${prefix} Collected ${isDataUrl ? "Base64" : "media URL"}: ${isDataUrl ? `(length: ${url.length})` : url.slice(0, 80) + "..."}`);
      }
      return true;
    }
    if (isLocalFilePath(url)) {
      if (!localMediaToSend.includes(url)) {
        localMediaToSend.push(url);
        log?.info(`${prefix} Collected local media for auto-routing: ${url}`);
      }
      return true;
    }
    return false;
  };

  if (payload.mediaUrls?.length) {
    for (const url of payload.mediaUrls) collectImageUrl(url);
  }
  if (payload.mediaUrl) collectImageUrl(payload.mediaUrl);

  // 提取 markdown 图片
  const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/gi;
  const mdMatches = [...replyText.matchAll(mdImageRegex)];
  for (const m of mdMatches) {
    const url = m[2]?.trim();
    if (url && !collectedImageUrls.includes(url)) {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        collectedImageUrls.push(url);
        log?.info(`${prefix} Extracted HTTP image from markdown: ${url.slice(0, 80)}...`);
      } else if (isLocalFilePath(url)) {
        if (!localMediaToSend.includes(url)) {
          localMediaToSend.push(url);
          log?.info(`${prefix} Collected local media from markdown for auto-routing: ${url}`);
        }
      }
    }
  }

  // 提取裸 URL 图片
  const bareUrlRegex = /(?<![(\["'])(https?:\/\/[^\s)"'<>]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s"'<>]*)?)/gi;
  const bareUrlMatches = [...replyText.matchAll(bareUrlRegex)];
  for (const m of bareUrlMatches) {
    const url = m[1];
    if (url && !collectedImageUrls.includes(url)) {
      collectedImageUrls.push(url);
      log?.info(`${prefix} Extracted bare image URL: ${url.slice(0, 80)}...`);
    }
  }

  const useMarkdown = account.markdownSupport === true;
  log?.info(`${prefix} Markdown mode: ${useMarkdown}, images: ${collectedImageUrls.length}`);

  let textWithoutImages = filterInternalMarkers(replyText);

  if (useMarkdown) {
    await sendMarkdownReply(textWithoutImages, collectedImageUrls, mdMatches, bareUrlMatches, event, actx, sendWithRetry, consumeQuoteRef);
  } else {
    await sendPlainTextReply(textWithoutImages, collectedImageUrls, mdMatches, bareUrlMatches, event, actx, sendWithRetry, consumeQuoteRef);
  }

  // 发送本地媒体（由 payload.mediaUrl 或 markdown 本地路径触发）
  if (localMediaToSend.length > 0) {
    log?.info(`${prefix} Sending ${localMediaToSend.length} local media via sendMedia auto-routing`);
    for (const mediaPath of localMediaToSend) {
      try {
        const result = await sendMediaAuto({
          to: qualifiedTarget, text: "", mediaUrl: mediaPath,
          accountId: account.accountId, replyToId: event.messageId, account,
        });
        if (result.error) {
          log?.error(`${prefix} sendMedia(auto) error for ${mediaPath}: ${result.error}`);
          await sendTextChunks("发送失败，请稍后重试。", event, actx, sendWithRetry, consumeQuoteRef);
        } else {
          log?.info(`${prefix} Sent local media: ${mediaPath}`);
        }
      } catch (err) {
        log?.error(`${prefix} sendMedia(auto) failed for ${mediaPath}: ${err}`);
        await sendTextChunks("发送失败，请稍后重试。", event, actx, sendWithRetry, consumeQuoteRef);
      }
    }
  }

  // 转发 tool 阶段收集的媒体（去重：跳过已在 localMediaToSend 或 collectedImageUrls 中发送过的路径）
  if (toolMediaUrls.length > 0) {
    const alreadySent = new Set([...localMediaToSend, ...collectedImageUrls]);
    const dedupedToolMedia = toolMediaUrls.filter(url => !alreadySent.has(url));
    if (dedupedToolMedia.length < toolMediaUrls.length) {
      log?.info(`${prefix} Deduped tool media: ${toolMediaUrls.length} → ${dedupedToolMedia.length} (skipped ${toolMediaUrls.length - dedupedToolMedia.length} already sent via localMedia/collectedImages)`);
    }
    if (dedupedToolMedia.length > 0) {
      log?.info(`${prefix} Forwarding ${dedupedToolMedia.length} tool-collected media URL(s) after block deliver`);
      for (const mediaUrl of dedupedToolMedia) {
        try {
          const result = await sendMediaAuto({
            to: qualifiedTarget, text: "", mediaUrl,
            accountId: account.accountId, replyToId: event.messageId, account,
          });
          if (result.error) {
            log?.error(`${prefix} Tool media forward error: ${result.error}`);
            await sendTextChunks("发送失败，请稍后重试。", event, actx, sendWithRetry, consumeQuoteRef);
          } else {
            log?.info(`${prefix} Forwarded tool media: ${mediaUrl.slice(0, 80)}...`);
          }
        } catch (err) {
          log?.error(`${prefix} Tool media forward failed: ${err}`);
          await sendTextChunks("发送失败，请稍后重试。", event, actx, sendWithRetry, consumeQuoteRef);
        }
      }
    }
    toolMediaUrls.length = 0;
  }
}

// ============ 内部辅助函数 ============

/** 发送文本分块（共用逻辑） */
async function sendTextChunks(
  text: string,
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
): Promise<void> {
  const { account, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;
  const chunks = getQQBotRuntime().channel.text.chunkMarkdownText(text, TEXT_CHUNK_LIMIT);
  for (const chunk of chunks) {
    try {
      await sendWithRetry(async (token) => {
        const ref = consumeQuoteRef();
        if (event.type === "c2c") {
          return await sendC2CMessage(token, event.senderId, chunk, event.messageId, ref);
        } else if (event.type === "group" && event.groupOpenid) {
          return await sendGroupMessage(token, event.groupOpenid, chunk, event.messageId);
        } else if (event.channelId) {
          return await sendChannelMessage(token, event.channelId, chunk, event.messageId);
        }
      });
      log?.info(`${prefix} Sent text chunk (${chunk.length}/${text.length} chars): ${chunk.slice(0, 50)}...`);
    } catch (err) {
      log?.error(`${prefix} Failed to send text chunk: ${err}`);
    }
  }
}

/** Markdown 模式发送 */
async function sendMarkdownReply(
  textWithoutImages: string,
  imageUrls: string[],
  mdMatches: RegExpMatchArray[],
  bareUrlMatches: RegExpMatchArray[],
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
): Promise<void> {
  const { account, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;

  // 分离图片：公网 URL vs Base64
  const httpImageUrls: string[] = [];
  const base64ImageUrls: string[] = [];
  for (const url of imageUrls) {
    if (url.startsWith("data:image/")) base64ImageUrls.push(url);
    else if (url.startsWith("http://") || url.startsWith("https://")) httpImageUrls.push(url);
  }
  log?.info(`${prefix} Image classification: httpUrls=${httpImageUrls.length}, base64=${base64ImageUrls.length}`);

  // 发送 Base64 图片
  if (base64ImageUrls.length > 0) {
    log?.info(`${prefix} Sending ${base64ImageUrls.length} image(s) via Rich Media API...`);
    for (const imageUrl of base64ImageUrls) {
      try {
        await sendWithRetry(async (token) => {
          if (event.type === "c2c") {
            await sendC2CImageMessage(token, event.senderId, imageUrl, event.messageId);
          } else if (event.type === "group" && event.groupOpenid) {
            await sendGroupImageMessage(token, event.groupOpenid, imageUrl, event.messageId);
          } else if (event.channelId) {
            log?.info(`${prefix} Channel does not support rich media, skipping Base64 image`);
          }
        });
        log?.info(`${prefix} Sent Base64 image via Rich Media API (size: ${imageUrl.length} chars)`);
      } catch (imgErr) {
        log?.error(`${prefix} Failed to send Base64 image via Rich Media API: ${imgErr}`);
      }
    }
  }

  // 处理公网 URL 图片
  const existingMdUrls = new Set(mdMatches.map((m) => m[2]));
  const imagesToAppend: string[] = [];

  for (const url of httpImageUrls) {
    if (!existingMdUrls.has(url)) {
      try {
        const size = await getImageSize(url);
        imagesToAppend.push(formatQQBotMarkdownImage(url, size));
        log?.info(`${prefix} Formatted HTTP image: ${size ? `${size.width}x${size.height}` : "default size"} - ${url.slice(0, 60)}...`);
      } catch (err) {
        log?.info(`${prefix} Failed to get image size, using default: ${err}`);
        imagesToAppend.push(formatQQBotMarkdownImage(url, null));
      }
    }
  }

  // 补充已有 markdown 图片的尺寸信息
  let result = textWithoutImages;
  for (const m of mdMatches) {
    const fullMatch = m[0];
    const imgUrl = m[2];
    const isHttpUrl = imgUrl.startsWith("http://") || imgUrl.startsWith("https://");
    if (isHttpUrl && !hasQQBotImageSize(fullMatch)) {
      try {
        const size = await getImageSize(imgUrl);
        result = result.replace(fullMatch, formatQQBotMarkdownImage(imgUrl, size));
        log?.info(`${prefix} Updated image with size: ${size ? `${size.width}x${size.height}` : "default"} - ${imgUrl.slice(0, 60)}...`);
      } catch (err) {
        log?.info(`${prefix} Failed to get image size for existing md, using default: ${err}`);
        result = result.replace(fullMatch, formatQQBotMarkdownImage(imgUrl, null));
      }
    }
  }

  // 移除裸 URL 图片
  for (const m of bareUrlMatches) {
    result = result.replace(m[0], "").trim();
  }

  // 追加图片
  if (imagesToAppend.length > 0) {
    result = result.trim();
    result = result ? result + "\n\n" + imagesToAppend.join("\n") : imagesToAppend.join("\n");
  }

  // 发送 markdown 文本
  if (result.trim()) {
    const mdChunks = chunkText(result, TEXT_CHUNK_LIMIT);
    for (const chunk of mdChunks) {
      try {
        await sendWithRetry(async (token) => {
          const ref = consumeQuoteRef();
          if (event.type === "c2c") {
            return await sendC2CMessage(token, event.senderId, chunk, event.messageId, ref);
          } else if (event.type === "group" && event.groupOpenid) {
            return await sendGroupMessage(token, event.groupOpenid, chunk, event.messageId);
          } else if (event.channelId) {
            return await sendChannelMessage(token, event.channelId, chunk, event.messageId);
          }
        });
        log?.info(`${prefix} Sent markdown chunk (${chunk.length}/${result.length} chars) with ${httpImageUrls.length} HTTP images (${event.type})`);
      } catch (err) {
        log?.error(`${prefix} Failed to send markdown message chunk: ${err}`);
      }
    }
  }
}

/** 普通文本模式发送 */
async function sendPlainTextReply(
  textWithoutImages: string,
  imageUrls: string[],
  mdMatches: RegExpMatchArray[],
  bareUrlMatches: RegExpMatchArray[],
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: ConsumeQuoteRefFn,
): Promise<void> {
  const { account, log } = actx;
  const prefix = `[qqbot:${account.accountId}]`;

  const imgMediaTarget: MediaTargetContext = {
    targetType: event.type === "c2c" ? "c2c" : event.type === "group" ? "group" : "channel",
    targetId: event.type === "c2c" ? event.senderId : event.type === "group" ? event.groupOpenid! : event.channelId!,
    account,
    replyToId: event.messageId,
    logPrefix: prefix,
  };

  let result = textWithoutImages;
  for (const m of mdMatches) result = result.replace(m[0], "").trim();
  for (const m of bareUrlMatches) result = result.replace(m[0], "").trim();

  // 群聊 URL 点号过滤
  if (result && event.type !== "c2c") {
    result = result.replace(/([a-zA-Z0-9])\.([a-zA-Z0-9])/g, "$1_$2");
  }

  try {
    for (const imageUrl of imageUrls) {
      try {
        const imgResult = await sendPhoto(imgMediaTarget, imageUrl);
        if (imgResult.error) {
          log?.error(`${prefix} Failed to send image: ${imgResult.error}`);
          await sendTextChunks(`发送图片失败：${imgResult.error}`, event, actx, sendWithRetry, consumeQuoteRef);
        } else {
          log?.info(`${prefix} Sent image via sendPhoto: ${imageUrl.slice(0, 80)}...`);
        }
      } catch (imgErr) {
        log?.error(`${prefix} Failed to send image: ${imgErr}`);
        await sendTextChunks(`发送图片失败：${imgErr}`, event, actx, sendWithRetry, consumeQuoteRef);
      }
    }

    if (result.trim()) {
      const plainChunks = chunkText(result, TEXT_CHUNK_LIMIT);
      for (const chunk of plainChunks) {
        await sendWithRetry(async (token) => {
          const ref = consumeQuoteRef();
          if (event.type === "c2c") {
            return await sendC2CMessage(token, event.senderId, chunk, event.messageId, ref);
          } else if (event.type === "group" && event.groupOpenid) {
            return await sendGroupMessage(token, event.groupOpenid, chunk, event.messageId);
          } else if (event.channelId) {
            return await sendChannelMessage(token, event.channelId, chunk, event.messageId);
          }
        });
        log?.info(`${prefix} Sent text chunk (${chunk.length}/${result.length} chars) (${event.type})`);
      }
    }
  } catch (err) {
    log?.error(`${prefix} Send failed: ${err}`);
  }
}
