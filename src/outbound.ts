/**
 * QQ Bot 消息发送模块
 */

import type { ResolvedQQBotAccount } from "./types.js";
import { decodeCronPayload } from "./utils/payload.js";
import {
  getAccessToken,
} from "./api.js";
import {
  checkMessageReplyLimit,
  recordMessageReply,
  getMessageReplyStats,
  getMessageReplyConfig,
  type ReplyLimitResult,
} from "./utils/reply-limiter.js";
import {
  parseTarget,
  sendTextToTarget,
  sendProactiveTextToTarget,
  sendImageToTarget,
  type SendTarget,
} from "./utils/send-target.js";
import { hasQqimgTags, parseQqimgToSendQueue } from "./utils/qqimg.js";
import { localImageToBase64, isLocalPath, isHttpUrl, isDataUrl } from "./utils/image-base64.js";

// 重新导出供外部使用
export {
  checkMessageReplyLimit,
  recordMessageReply,
  getMessageReplyStats,
  getMessageReplyConfig,
  type ReplyLimitResult,
};

export interface OutboundContext {
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  account: ResolvedQQBotAccount;
}

export interface MediaOutboundContext extends OutboundContext {
  mediaUrl: string;
}

export interface OutboundResult {
  channel: string;
  messageId?: string;
  timestamp?: string | number;
  error?: string;
}

// ============ 辅助函数 ============

/** 获取 token 并发送消息（被动或主动） */
async function sendTextWithTarget(
  accessToken: string,
  target: SendTarget,
  text: string,
  replyToId: string | null | undefined,
): Promise<OutboundResult> {
  let result: { id: string; timestamp: number | string };
  if (replyToId) {
    result = await sendTextToTarget(accessToken, target, text, replyToId);
    recordMessageReply(replyToId);
  } else {
    result = await sendProactiveTextToTarget(accessToken, target, text);
  }
  return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
}

/**
 * 发送文本消息
 * - 有 replyToId: 被动回复，1小时内最多回复4次
 * - 无 replyToId: 主动发送
 * - 支持 <qqimg>路径</qqimg> 格式发送图片
 */
export async function sendText(ctx: OutboundContext): Promise<OutboundResult> {
  const { to, account } = ctx;
  const { text } = ctx;
  let { replyToId } = ctx;
  let fallbackToProactive = false;

  console.log("[qqbot] sendText ctx:", JSON.stringify({ to, text: text?.slice(0, 50), replyToId, accountId: account.accountId }, null, 2));

  // ============ 消息回复限流检查 ============
  if (replyToId) {
    const limitCheck = checkMessageReplyLimit(replyToId);
    if (!limitCheck.allowed) {
      if (limitCheck.shouldFallbackToProactive) {
        console.warn(`[qqbot] sendText: 被动回复不可用，降级为主动消息 - ${limitCheck.message}`);
        fallbackToProactive = true;
        replyToId = null;
      } else {
        console.error(`[qqbot] sendText: 消息回复被限流 - ${limitCheck.message}`);
        return { channel: "qqbot", error: limitCheck.message };
      }
    } else {
      console.log(`[qqbot] sendText: 消息 ${replyToId} 剩余被动回复次数: ${limitCheck.remaining}`);
    }
  }

  // ============ <qqimg> 标签处理 ============
  if (hasQqimgTags(text)) {
    const sendQueue = parseQqimgToSendQueue(text);
    console.log(`[qqbot] sendText: Send queue: ${sendQueue.map(item => item.type).join(" -> ")}`);

    if (!account.appId || !account.clientSecret) {
      return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
    }

    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);
    let lastResult: OutboundResult = { channel: "qqbot" };

    for (const item of sendQueue) {
      try {
        if (item.type === "text") {
          lastResult = await sendTextWithTarget(accessToken, target, item.content, replyToId);
          console.log(`[qqbot] sendText: Sent text part: ${item.content.slice(0, 30)}...`);
        } else if (item.type === "image") {
          const imageUrl = resolveImageUrl(item.content);
          if (!imageUrl) continue;

          const imgResult = await sendImageToTarget(accessToken, target, imageUrl, replyToId ?? undefined);
          if (imgResult) {
            lastResult = { channel: "qqbot", messageId: imgResult.id, timestamp: imgResult.timestamp };
          }
          console.log(`[qqbot] sendText: Sent image via <qqimg> tag: ${item.content.slice(0, 60)}...`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[qqbot] sendText: Failed to send ${item.type}: ${errMsg}`);
      }
    }
    return lastResult;
  }

  // ============ 主动消息校验 ============
  if (!replyToId) {
    if (!text || text.trim().length === 0) {
      console.error("[qqbot] sendText error: 主动消息的内容不能为空");
      return { channel: "qqbot", error: "主动消息必须有内容" };
    }
    if (fallbackToProactive) {
      console.log(`[qqbot] sendText: [降级] 发送主动消息到 ${to}`);
    } else {
      console.log(`[qqbot] sendText: 发送主动消息到 ${to}, 内容长度: ${text.length}`);
    }
  }

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);
    console.log("[qqbot] sendText target:", JSON.stringify(target));
    return await sendTextWithTarget(accessToken, target, text, replyToId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 主动发送消息（不需要 replyToId）
 */
export async function sendProactiveMessage(
  account: ResolvedQQBotAccount,
  to: string,
  text: string
): Promise<OutboundResult> {
  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  console.log(`[qqbot] sendProactiveMessage: to=${to}, text length=${text.length}`);

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);
    const result = await sendProactiveTextToTarget(accessToken, target, text);
    console.log(`[qqbot] sendProactiveMessage: sent, messageId=${result.id}`);
    return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot] sendProactiveMessage: error: ${errorMessage}`);
    return { channel: "qqbot", error: errorMessage };
  }
}

/**
 * 发送富媒体消息（图片）
 *
 * 支持: 公网 URL / Base64 Data URL / 本地文件路径
 */
export async function sendMedia(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account, mediaUrl } = ctx;

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  if (!mediaUrl) {
    return { channel: "qqbot", error: "mediaUrl is required for sendMedia" };
  }

  // 处理本地文件路径 → Base64
  const processedMediaUrl = resolveImageUrl(mediaUrl);
  if (!processedMediaUrl) {
    return { channel: "qqbot", error: `不支持的图片格式或路径: ${mediaUrl.slice(0, 80)}` };
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    // 发送图片
    const imageResult = await sendImageToTarget(accessToken, target, processedMediaUrl, replyToId ?? undefined);
    if (!imageResult) {
      // 频道不支持的情况，发送文本 + URL
      const displayUrl = isLocalPath(mediaUrl) ? "[本地文件]" : mediaUrl;
      const textWithUrl = text ? `${text}\n${displayUrl}` : displayUrl;
      const result = await sendTextToTarget(accessToken, target, textWithUrl, replyToId ?? undefined);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    }

    // 如果有文本说明，再发送一条文本消息
    if (text?.trim()) {
      try {
        await sendTextToTarget(accessToken, target, text, replyToId ?? undefined);
      } catch (textErr) {
        console.error(`[qqbot] Failed to send text after image: ${textErr}`);
      }
    }

    return { channel: "qqbot", messageId: imageResult.id, timestamp: imageResult.timestamp };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 发送 Cron 触发的消息
 */
export async function sendCronMessage(
  account: ResolvedQQBotAccount,
  to: string,
  message: string
): Promise<OutboundResult> {
  console.log(`[qqbot] sendCronMessage: to=${to}, message length=${message.length}`);

  const cronResult = decodeCronPayload(message);

  if (cronResult.isCronPayload) {
    if (cronResult.error) {
      console.error(`[qqbot] sendCronMessage: cron payload decode error: ${cronResult.error}`);
      return { channel: "qqbot", error: `Cron 载荷解码失败: ${cronResult.error}` };
    }

    if (cronResult.payload) {
      const payload = cronResult.payload;
      const targetTo = payload.targetType === "group"
        ? `group:${payload.targetAddress}`
        : payload.targetAddress;

      console.log(`[qqbot] sendCronMessage: sending to ${targetTo}`);
      return await sendProactiveMessage(account, targetTo, payload.content);
    }
  }

  // 非结构化载荷
  console.log(`[qqbot] sendCronMessage: plain text message, sending to ${to}`);
  return await sendProactiveMessage(account, to, message);
}

// ============ 内部辅助 ============

/**
 * 将图片路径解析为可发送的 URL（本地文件 → Base64 Data URL）
 * @returns 可发送的 URL 或 null（不支持的格式）
 */
function resolveImageUrl(imagePath: string): string | null {
  if (isHttpUrl(imagePath) || isDataUrl(imagePath)) {
    return imagePath;
  }

  if (isLocalPath(imagePath)) {
    const result = localImageToBase64(imagePath);
    if ("error" in result) {
      console.error(`[qqbot] resolveImageUrl: ${result.error}`);
      return null;
    }
    console.log(`[qqbot] resolveImageUrl: Converted local image to Base64 (size: ${result.sizeBytes} bytes)`);
    return result.dataUrl;
  }

  // 相对路径等
  if (imagePath.startsWith("./") || imagePath.startsWith("../")) {
    const result = localImageToBase64(imagePath);
    if ("error" in result) {
      console.error(`[qqbot] resolveImageUrl: ${result.error}`);
      return null;
    }
    return result.dataUrl;
  }

  console.log(`[qqbot] resolveImageUrl: unsupported format: ${imagePath.slice(0, 50)}`);
  return null;
}
