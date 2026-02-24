/**
 * Gateway 出站消息投递
 * 处理 AI 响应到 QQ 的发送：qqimg 标签、结构化载荷、markdown、富媒体等
 */

import type { ResolvedQQBotAccount } from "./types.js";
import {
  parseQQBotPayload,
  encodePayloadForCron,
  isCronReminderPayload,
  isMediaPayload,
  type CronReminderPayload,
  type MediaPayload,
} from "./utils/payload.js";
import { getImageSize, formatQQBotMarkdownImage, hasQQBotImageSize } from "./utils/image-size.js";
import { parseQqimgToSendQueue } from "./utils/qqimg.js";
import { filterInternalMarkers } from "./utils/text.js";
import { localImageToBase64, isLocalPath, isHttpUrl } from "./utils/image-base64.js";
import {
  targetFromEvent,
  sendTextToTarget,
  sendImageToTarget,
  withTokenRetry,
  type SendTarget,
  type MessageEventContext,
} from "./utils/send-target.js";

export interface DeliverContext {
  event: MessageEventContext & {
    type: "c2c" | "guild" | "dm" | "group";
    groupOpenid?: string;
    channelId?: string;
  };
  account: ResolvedQQBotAccount;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
  /** 记录 outbound 活动 */
  recordActivity: () => void;
}

/**
 * 辅助：发送错误提示给用户
 */
async function sendErrorMessage(
  ctx: DeliverContext,
  errorText: string,
): Promise<void> {
  const { event, account } = ctx;
  try {
    await withTokenRetry(account.appId, account.clientSecret, async (token) => {
      const target = targetFromEvent(event);
      await sendTextToTarget(token, target, errorText, event.messageId);
    });
  } catch (sendErr) {
    ctx.log?.error(`[qqbot:${account.accountId}] Failed to send error message: ${sendErr}`);
  }
}

/**
 * 辅助：发送图片（带 token 重试 + 本地 → Base64）
 */
async function sendImage(
  ctx: DeliverContext,
  imagePath: string,
): Promise<boolean> {
  const { event, account, log } = ctx;
  const target = targetFromEvent(event);
  let imageUrl = imagePath;

  const isLocal = isLocalPath(imagePath);
  const isHttp = isHttpUrl(imagePath);

  if (isLocal) {
    const result = localImageToBase64(imagePath);
    if ("error" in result) {
      log?.error(`[qqbot:${account.accountId}] ${result.error}`);
      await sendErrorMessage(ctx, result.error);
      return false;
    }
    imageUrl = result.dataUrl;
    log?.info(`[qqbot:${account.accountId}] Converted local image to Base64 (size: ${result.sizeBytes} bytes)`);
  } else if (!isHttp && !imagePath.startsWith("data:")) {
    log?.error(`[qqbot:${account.accountId}] Invalid image path: ${imagePath}`);
    return false;
  }

  await withTokenRetry(account.appId, account.clientSecret, async (token) => {
    await sendImageToTarget(token, target, imageUrl, event.messageId);
  });
  log?.info(`[qqbot:${account.accountId}] Sent image: ${imagePath.slice(0, 60)}...`);
  return true;
}

/**
 * 处理 deliver 回调的主入口
 * 从 gateway 的 dispatchReplyWithBufferedBlockDispatcher.deliver 调用
 */
export async function handleDeliver(
  ctx: DeliverContext,
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
  _info: { kind: string },
): Promise<void> {
  const { event, account, log, recordActivity } = ctx;
  const replyText = payload.text ?? "";
  const target = targetFromEvent(event);

  // ============ <qqimg> 标签处理 ============
  const qqimgQueue = parseQqimgToSendQueue(replyText, filterInternalMarkers);
  const hasQqimg = qqimgQueue.length > 0 && qqimgQueue.some(item => item.type === "image");

  if (hasQqimg) {
    log?.info(`[qqbot:${account.accountId}] Detected <qqimg> tag(s), processing queue...`);

    for (const item of qqimgQueue) {
      if (item.type === "text") {
        try {
          await withTokenRetry(account.appId, account.clientSecret, async (token) => {
            await sendTextToTarget(token, target, item.content, event.messageId);
          });
          log?.info(`[qqbot:${account.accountId}] Sent text: ${item.content.slice(0, 50)}...`);
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Failed to send text: ${err}`);
        }
      } else if (item.type === "image") {
        try {
          await sendImage(ctx, item.content);
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Failed to send image from <qqimg>: ${err}`);
          await sendErrorMessage(ctx, `图片发送失败，图片似乎不存在哦，图片路径：${item.content}`);
        }
      }
    }

    recordActivity();
    return;
  }

  // ============ 结构化载荷检测 ============
  const payloadResult = parseQQBotPayload(replyText);

  if (payloadResult.isPayload) {
    if (payloadResult.error) {
      log?.error(`[qqbot:${account.accountId}] Payload parse error: ${payloadResult.error}`);
      await sendErrorMessage(ctx, `[QQBot] 载荷解析失败: ${payloadResult.error}`);
      return;
    }

    if (payloadResult.payload) {
      const parsed = payloadResult.payload;
      log?.info(`[qqbot:${account.accountId}] Detected structured payload, type: ${parsed.type}`);

      if (isCronReminderPayload(parsed)) {
        await handleCronReminderPayload(ctx, parsed);
        recordActivity();
        return;
      } else if (isMediaPayload(parsed)) {
        await handleMediaPayload(ctx, parsed);
        recordActivity();
        return;
      } else {
        log?.error(`[qqbot:${account.accountId}] Unknown payload type: ${(parsed as Record<string, unknown>).type}`);
        await sendErrorMessage(ctx, `[QQBot] 不支持的载荷类型: ${(parsed as Record<string, unknown>).type}`);
        return;
      }
    }
  }

  // ============ 非结构化消息处理 ============
  await handlePlainMessage(ctx, replyText, payload);
  recordActivity();
}

/**
 * 处理定时提醒载荷
 */
async function handleCronReminderPayload(
  ctx: DeliverContext,
  parsed: CronReminderPayload,
): Promise<void> {
  const { event, account, log } = ctx;
  const target = targetFromEvent(event);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = parsed as any;
  log?.info(`[qqbot:${account.accountId}] Processing cron_reminder payload`);
  const _cronMessage = encodePayloadForCron(payload);

  const confirmText = `⏰ 提醒已设置，将在指定时间发送: "${payload.content}"`;
  try {
    await withTokenRetry(account.appId, account.clientSecret, async (token) => {
      await sendTextToTarget(token, target, confirmText, event.messageId);
    });
    log?.info(`[qqbot:${account.accountId}] Cron reminder confirmation sent`);
  } catch (err) {
    log?.error(`[qqbot:${account.accountId}] Failed to send cron confirmation: ${err}`);
  }
}

/**
 * 处理媒体消息载荷
 */
async function handleMediaPayload(
  ctx: DeliverContext,
  parsed: unknown,
): Promise<void> {
  const { event, account, log } = ctx;
  const target = targetFromEvent(event);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mediaPayload = parsed as any as MediaPayload;

  log?.info(`[qqbot:${account.accountId}] Processing media payload, mediaType: ${mediaPayload.mediaType}`);

  if (mediaPayload.mediaType === "image") {
    let imageUrl = mediaPayload.path;

    if (mediaPayload.source === "file") {
      const result = localImageToBase64(imageUrl);
      if ("error" in result) {
        await sendErrorMessage(ctx, `[QQBot] ${result.error}`);
        return;
      }
      imageUrl = result.dataUrl;
      log?.info(`[qqbot:${account.accountId}] Converted local image to Base64 (size: ${result.sizeBytes} bytes)`);
    }

    try {
      await withTokenRetry(account.appId, account.clientSecret, async (token) => {
        await sendImageToTarget(token, target, imageUrl, event.messageId);
      });
      log?.info(`[qqbot:${account.accountId}] Sent image via media payload`);

      if (mediaPayload.caption) {
        await withTokenRetry(account.appId, account.clientSecret, async (token) => {
          await sendTextToTarget(token, target, mediaPayload.caption!, event.messageId);
        });
      }
    } catch (err) {
      log?.error(`[qqbot:${account.accountId}] Failed to send image: ${err}`);
      await sendErrorMessage(ctx, `[QQBot] 发送图片失败: ${err}`);
    }
  } else if (mediaPayload.mediaType === "audio") {
    await sendErrorMessage(ctx, `[QQBot] 音频发送功能暂未实现，敬请期待~`);
  } else if (mediaPayload.mediaType === "video") {
    await sendErrorMessage(ctx, `[QQBot] 视频发送功能暂不支持`);
  } else {
    await sendErrorMessage(ctx, `[QQBot] 不支持的媒体类型: ${mediaPayload.mediaType}`);
  }
}

/**
 * 处理普通（非结构化）消息：markdown、富媒体、纯文本
 */
async function handlePlainMessage(
  ctx: DeliverContext,
  replyText: string,
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string },
): Promise<void> {
  const { event, account, log } = ctx;
  const target = targetFromEvent(event);
  const useMarkdown = account.markdownSupport === true;

  // 收集图片 URL（仅公网 URL 和 Base64）
  const imageUrls: string[] = [];
  const collectImageUrl = (url: string | undefined | null): boolean => {
    if (!url) return false;
    const isHttp = isHttpUrl(url);
    const isData = url.startsWith("data:image/");
    if ((isHttp || isData) && !imageUrls.includes(url)) {
      imageUrls.push(url);
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
  for (const match of mdMatches) {
    const url = match[2]?.trim();
    if (url && !imageUrls.includes(url) && isHttpUrl(url)) {
      imageUrls.push(url);
    }
  }

  // 提取裸 URL 图片
  const bareUrlRegex = /(?<![(\["'])(https?:\/\/[^\s)"'<>]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s"'<>]*)?)/gi;
  const bareUrlMatches = [...replyText.matchAll(bareUrlRegex)];
  for (const match of bareUrlMatches) {
    const url = match[1];
    if (url && !imageUrls.includes(url)) imageUrls.push(url);
  }

  log?.info(`[qqbot:${account.accountId}] Markdown mode: ${useMarkdown}, images: ${imageUrls.length}`);

  const textWithoutImages = filterInternalMarkers(replyText);

  if (useMarkdown) {
    await handleMarkdownMode(ctx, target, textWithoutImages, imageUrls, mdMatches, bareUrlMatches);
  } else {
    await handlePlainTextMode(ctx, target, textWithoutImages, imageUrls, mdMatches, bareUrlMatches);
  }
}

/**
 * Markdown 模式消息发送
 */
async function handleMarkdownMode(
  ctx: DeliverContext,
  target: SendTarget,
  textWithoutImages: string,
  imageUrls: string[],
  mdMatches: RegExpExecArray[],
  bareUrlMatches: RegExpExecArray[],
): Promise<void> {
  const { event, account, log } = ctx;

  // 分离公网 URL vs Base64
  const httpImageUrls: string[] = [];
  const base64ImageUrls: string[] = [];
  for (const url of imageUrls) {
    if (url.startsWith("data:image/")) base64ImageUrls.push(url);
    else if (isHttpUrl(url)) httpImageUrls.push(url);
  }

  // 发送 Base64 图片
  if (base64ImageUrls.length > 0) {
    for (const imageUrl of base64ImageUrls) {
      try {
        await withTokenRetry(account.appId, account.clientSecret, async (token) => {
          await sendImageToTarget(token, target, imageUrl, event.messageId);
        });
      } catch (imgErr) {
        log?.error(`[qqbot:${account.accountId}] Failed to send Base64 image: ${imgErr}`);
      }
    }
  }

  // 追加公网图片（不在文本中的）
  const existingMdUrls = new Set(mdMatches.map(m => m[2]));
  const imagesToAppend: string[] = [];

  for (const url of httpImageUrls) {
    if (!existingMdUrls.has(url)) {
      try {
        const size = await getImageSize(url);
        imagesToAppend.push(formatQQBotMarkdownImage(url, size));
      } catch {
        imagesToAppend.push(formatQQBotMarkdownImage(url, null));
      }
    }
  }

  // 补充已有 markdown 图片尺寸
  for (const match of mdMatches) {
    const fullMatch = match[0];
    const imgUrl = match[2];
    if (isHttpUrl(imgUrl) && !hasQQBotImageSize(fullMatch)) {
      try {
        const size = await getImageSize(imgUrl);
        textWithoutImages = textWithoutImages.replace(fullMatch, formatQQBotMarkdownImage(imgUrl, size));
      } catch {
        textWithoutImages = textWithoutImages.replace(fullMatch, formatQQBotMarkdownImage(imgUrl, null));
      }
    }
  }

  // 移除裸 URL
  for (const match of bareUrlMatches) {
    textWithoutImages = textWithoutImages.replace(match[0], "").trim();
  }

  // 追加图片
  if (imagesToAppend.length > 0) {
    textWithoutImages = textWithoutImages.trim();
    if (textWithoutImages) {
      textWithoutImages += "\n\n" + imagesToAppend.join("\n");
    } else {
      textWithoutImages = imagesToAppend.join("\n");
    }
  }

  // 发送最终文本
  if (textWithoutImages.trim()) {
    try {
      await withTokenRetry(account.appId, account.clientSecret, async (token) => {
        await sendTextToTarget(token, target, textWithoutImages, event.messageId);
      });
      log?.info(`[qqbot:${account.accountId}] Sent markdown message (${event.type})`);
    } catch (err) {
      log?.error(`[qqbot:${account.accountId}] Failed to send markdown message: ${err}`);
    }
  }
}

/**
 * 纯文本模式消息发送
 */
async function handlePlainTextMode(
  ctx: DeliverContext,
  target: SendTarget,
  textWithoutImages: string,
  imageUrls: string[],
  mdMatches: RegExpExecArray[],
  bareUrlMatches: RegExpExecArray[],
): Promise<void> {
  const { event, account, log } = ctx;

  // 移除图片引用
  for (const match of mdMatches) {
    textWithoutImages = textWithoutImages.replace(match[0], "").trim();
  }
  for (const match of bareUrlMatches) {
    textWithoutImages = textWithoutImages.replace(match[0], "").trim();
  }

  // 群聊过滤 URL 点号
  if (textWithoutImages && event.type !== "c2c") {
    textWithoutImages = textWithoutImages.replace(/([a-zA-Z0-9])\.([a-zA-Z0-9])/g, "$1_$2");
  }

  try {
    // 发送图片
    for (const imageUrl of imageUrls) {
      try {
        await withTokenRetry(account.appId, account.clientSecret, async (token) => {
          await sendImageToTarget(token, target, imageUrl, event.messageId);
        });
        log?.info(`[qqbot:${account.accountId}] Sent image: ${imageUrl.slice(0, 80)}...`);
      } catch (imgErr) {
        log?.error(`[qqbot:${account.accountId}] Failed to send image: ${imgErr}`);
      }
    }

    // 发送文本
    if (textWithoutImages.trim()) {
      await withTokenRetry(account.appId, account.clientSecret, async (token) => {
        await sendTextToTarget(token, target, textWithoutImages, event.messageId);
      });
      log?.info(`[qqbot:${account.accountId}] Sent text reply (${event.type})`);
    }
  } catch (err) {
    log?.error(`[qqbot:${account.accountId}] Send failed: ${err}`);
  }
}
