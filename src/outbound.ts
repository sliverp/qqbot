/**
 * QQ Bot 消息发送模块
 */

import * as fs from "fs";
import * as path from "path";
import type { ResolvedQQBotAccount } from "./types.js";
import { decodeCronPayload } from "./utils/payload.js";
import {
  getAccessToken, 
  sendC2CMessage, 
  sendChannelMessage, 
  sendGroupMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
  sendC2CImageMessage,
  sendGroupImageMessage,
} from "./api.js";

// ============ 消息回复限流器 ============
// 同一 message_id 1小时内最多回复 4 次，超过 1 小时无法被动回复（需改为主动消息）
const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1小时

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();

/** 限流检查结果 */
export interface ReplyLimitResult {
  /** 是否允许被动回复 */
  allowed: boolean;
  /** 剩余被动回复次数 */
  remaining: number;
  /** 是否需要降级为主动消息（超期或超过次数） */
  shouldFallbackToProactive: boolean;
  /** 降级原因 */
  fallbackReason?: "expired" | "limit_exceeded";
  /** 提示消息 */
  message?: string;
}

/**
 * 检查是否可以回复该消息（限流检查）
 * @param messageId 消息ID
 * @returns ReplyLimitResult 限流检查结果
 */
export function checkMessageReplyLimit(messageId: string): ReplyLimitResult {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  // 清理过期记录（定期清理，避免内存泄漏）
  if (messageReplyTracker.size > 10000) {
    for (const [id, rec] of messageReplyTracker) {
      if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
        messageReplyTracker.delete(id);
      }
    }
  }
  
  // 新消息，首次回复
  if (!record) {
    return { 
      allowed: true, 
      remaining: MESSAGE_REPLY_LIMIT,
      shouldFallbackToProactive: false,
    };
  }
  
  // 检查是否超过1小时（message_id 过期）
  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    // 超过1小时，被动回复不可用，需要降级为主动消息
    return { 
      allowed: false, 
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "expired",
      message: `消息已超过1小时有效期，将使用主动消息发送`,
    };
  }
  
  // 检查是否超过回复次数限制
  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  if (remaining <= 0) {
    return { 
      allowed: false, 
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "limit_exceeded",
      message: `该消息已达到1小时内最大回复次数(${MESSAGE_REPLY_LIMIT}次)，将使用主动消息发送`,
    };
  }
  
  return { 
    allowed: true, 
    remaining,
    shouldFallbackToProactive: false,
  };
}

/**
 * 记录一次消息回复
 * @param messageId 消息ID
 */
export function recordMessageReply(messageId: string): void {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);
  
  if (!record) {
    messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else {
    // 检查是否过期，过期则重新计数
    if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
      messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
    } else {
      record.count++;
    }
  }
  console.log(`[qqbot] recordMessageReply: ${messageId}, count=${messageReplyTracker.get(messageId)?.count}`);
}

/**
 * 获取消息回复统计信息
 */
export function getMessageReplyStats(): { trackedMessages: number; totalReplies: number } {
  let totalReplies = 0;
  for (const record of messageReplyTracker.values()) {
    totalReplies += record.count;
  }
  return { trackedMessages: messageReplyTracker.size, totalReplies };
}

/**
 * 获取消息回复限制配置（供外部查询）
 */
export function getMessageReplyConfig(): { limit: number; ttlMs: number; ttlHours: number } {
  return {
    limit: MESSAGE_REPLY_LIMIT,
    ttlMs: MESSAGE_REPLY_TTL,
    ttlHours: MESSAGE_REPLY_TTL / (60 * 60 * 1000),
  };
}

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

/**
 * 解析目标地址
 * 格式：
 *   - openid (32位十六进制) -> C2C 单聊
 *   - group:xxx -> 群聊
 *   - channel:xxx -> 频道
 *   - 纯数字 -> 频道
 */
function parseTarget(to: string): { type: "c2c" | "group" | "channel"; id: string } {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [qqbot] parseTarget: input=${to}`);
  
  // 去掉 qqbot: 前缀
  let id = to.replace(/^qqbot:/i, "");
  
  if (id.startsWith("c2c:")) {
    const userId = id.slice(4);
    if (!userId || userId.length === 0) {
      const error = `Invalid c2c target format: ${to} - missing user ID`;
      console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    console.log(`[${timestamp}] [qqbot] parseTarget: c2c target, user ID=${userId}`);
    return { type: "c2c", id: userId };
  }
  
  if (id.startsWith("group:")) {
    const groupId = id.slice(6);
    if (!groupId || groupId.length === 0) {
      const error = `Invalid group target format: ${to} - missing group ID`;
      console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    console.log(`[${timestamp}] [qqbot] parseTarget: group target, group ID=${groupId}`);
    return { type: "group", id: groupId };
  }
  
  if (id.startsWith("channel:")) {
    const channelId = id.slice(8);
    if (!channelId || channelId.length === 0) {
      const error = `Invalid channel target format: ${to} - missing channel ID`;
      console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
      throw new Error(error);
    }
    console.log(`[${timestamp}] [qqbot] parseTarget: channel target, channel ID=${channelId}`);
    return { type: "channel", id: channelId };
  }
  
  // 默认当作 c2c（私聊）
  if (!id || id.length === 0) {
    const error = `Invalid target format: ${to} - empty ID after removing qqbot: prefix`;
    console.error(`[${timestamp}] [qqbot] parseTarget: ${error}`);
    throw new Error(error);
  }
  
  console.log(`[${timestamp}] [qqbot] parseTarget: default c2c target, ID=${id}`);
  return { type: "c2c", id };
}

/**
 * 发送文本消息
 * - 有 replyToId: 被动回复，1小时内最多回复4次
 * - 无 replyToId: 主动发送，有配额限制（每月4条/用户/群）
 * 
 * 注意：
 * 1. 主动消息（无 replyToId）必须有消息内容，不支持流式发送
 * 2. 当被动回复不可用（超期或超过次数）时，自动降级为主动消息
 * 3. 支持 <qqimg>路径</qqimg> 或 <qqimg>路径</img> 格式发送图片
 */
export async function sendText(ctx: OutboundContext): Promise<OutboundResult> {
  const { to, account } = ctx;
  let { text, replyToId } = ctx;
  let fallbackToProactive = false;

  console.log("[qqbot] sendText ctx:", JSON.stringify({ to, text: text?.slice(0, 50), replyToId, accountId: account.accountId }, null, 2));

  // ============ 消息回复限流检查 ============
  // 如果有 replyToId，检查是否可以被动回复
  if (replyToId) {
    const limitCheck = checkMessageReplyLimit(replyToId);
    
    if (!limitCheck.allowed) {
      // 检查是否需要降级为主动消息
      if (limitCheck.shouldFallbackToProactive) {
        console.warn(`[qqbot] sendText: 被动回复不可用，降级为主动消息 - ${limitCheck.message}`);
        fallbackToProactive = true;
        replyToId = null; // 清除 replyToId，改为主动消息
      } else {
        // 不应该发生，但作为保底
        console.error(`[qqbot] sendText: 消息回复被限流但未设置降级 - ${limitCheck.message}`);
        return { 
          channel: "qqbot", 
          error: limitCheck.message 
        };
      }
    } else {
      console.log(`[qqbot] sendText: 消息 ${replyToId} 剩余被动回复次数: ${limitCheck.remaining}/${MESSAGE_REPLY_LIMIT}`);
    }
  }

  // ============ <qqimg> 标签检测与处理 ============
  // 支持 <qqimg>路径</qqimg> 或 <qqimg>路径</img> 格式发送图片
  const qqimgRegex = /<qqimg>([^<>]+)<\/(?:qqimg|img)>/gi;
  const qqimgMatches = text.match(qqimgRegex);
  
  if (qqimgMatches && qqimgMatches.length > 0) {
    console.log(`[qqbot] sendText: Detected ${qqimgMatches.length} <qqimg> tag(s), processing...`);
    
    // 构建发送队列：根据内容在原文中的实际位置顺序发送
    const sendQueue: Array<{ type: "text" | "image"; content: string }> = [];
    
    let lastIndex = 0;
    const qqimgRegexWithIndex = /<qqimg>([^<>]+)<\/(?:qqimg|img)>/gi;
    let match;
    
    while ((match = qqimgRegexWithIndex.exec(text)) !== null) {
      // 添加标签前的文本
      const textBefore = text.slice(lastIndex, match.index).replace(/\n{3,}/g, "\n\n").trim();
      if (textBefore) {
        sendQueue.push({ type: "text", content: textBefore });
      }
      
      // 添加图片
      const imagePath = match[1]?.trim();
      if (imagePath) {
        sendQueue.push({ type: "image", content: imagePath });
        console.log(`[qqbot] sendText: Found image path in <qqimg>: ${imagePath}`);
      }
      
      lastIndex = match.index + match[0].length;
    }
    
    // 添加最后一个标签后的文本
    const textAfter = text.slice(lastIndex).replace(/\n{3,}/g, "\n\n").trim();
    if (textAfter) {
      sendQueue.push({ type: "text", content: textAfter });
    }
    
    console.log(`[qqbot] sendText: Send queue: ${sendQueue.map(item => item.type).join(" -> ")}`);
    
    // 按顺序发送
    if (!account.appId || !account.clientSecret) {
      return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
    }
    
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);
    let lastResult: OutboundResult = { channel: "qqbot" };
    
    for (const item of sendQueue) {
      try {
        if (item.type === "text") {
          // 发送文本
          if (replyToId) {
            // 被动回复
            if (target.type === "c2c") {
              const result = await sendC2CMessage(accessToken, target.id, item.content, replyToId);
              recordMessageReply(replyToId);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            } else if (target.type === "group") {
              const result = await sendGroupMessage(accessToken, target.id, item.content, replyToId);
              recordMessageReply(replyToId);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, item.content, replyToId);
              recordMessageReply(replyToId);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            }
          } else {
            // 主动消息
            if (target.type === "c2c") {
              const result = await sendProactiveC2CMessage(accessToken, target.id, item.content);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            } else if (target.type === "group") {
              const result = await sendProactiveGroupMessage(accessToken, target.id, item.content);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            } else {
              const result = await sendChannelMessage(accessToken, target.id, item.content);
              lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
            }
          }
          console.log(`[qqbot] sendText: Sent text part: ${item.content.slice(0, 30)}...`);
        } else if (item.type === "image") {
          // 发送图片
          const imagePath = item.content;
          const isHttpUrl = imagePath.startsWith("http://") || imagePath.startsWith("https://");
          
          let imageUrl = imagePath;
          
          // 如果是本地文件路径，读取并转换为 Base64
          if (!isHttpUrl && !imagePath.startsWith("data:")) {
            if (fs.existsSync(imagePath)) {
              const fileBuffer = fs.readFileSync(imagePath);
              const ext = path.extname(imagePath).toLowerCase();
              const mimeTypes: Record<string, string> = {
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".png": "image/png",
                ".gif": "image/gif",
                ".webp": "image/webp",
                ".bmp": "image/bmp",
              };
              const mimeType = mimeTypes[ext] ?? "image/png";
              imageUrl = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
              console.log(`[qqbot] sendText: Converted local image to Base64 (size: ${fileBuffer.length} bytes)`);
            } else {
              console.error(`[qqbot] sendText: Image file not found: ${imagePath}`);
              continue; // 跳过不存在的图片
            }
          }
          
          // 发送图片
          if (target.type === "c2c") {
            const result = await sendC2CImageMessage(accessToken, target.id, imageUrl, replyToId ?? undefined);
            lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
          } else if (target.type === "group") {
            const result = await sendGroupImageMessage(accessToken, target.id, imageUrl, replyToId ?? undefined);
            lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
          } else if (isHttpUrl) {
            // 频道使用 Markdown 格式（仅支持公网 URL）
            const result = await sendChannelMessage(accessToken, target.id, `![](${imagePath})`, replyToId ?? undefined);
            lastResult = { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
          }
          console.log(`[qqbot] sendText: Sent image via <qqimg> tag: ${imagePath.slice(0, 60)}...`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[qqbot] sendText: Failed to send ${item.type}: ${errMsg}`);
        // 继续发送队列中的其他内容
      }
    }
    
    return lastResult;
  }

  // ============ 主动消息校验（参考 Telegram 机制） ============
  // 如果是主动消息（无 replyToId 或降级后），必须有消息内容
  if (!replyToId) {
    if (!text || text.trim().length === 0) {
      console.error("[qqbot] sendText error: 主动消息的内容不能为空 (text is empty)");
      return { 
        channel: "qqbot", 
        error: "主动消息必须有内容 (--message 参数不能为空)" 
      };
    }
    if (fallbackToProactive) {
      console.log(`[qqbot] sendText: [降级] 发送主动消息到 ${to}, 内容长度: ${text.length}`);
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

    // 如果没有 replyToId，使用主动发送接口
    if (!replyToId) {
      if (target.type === "c2c") {
        const result = await sendProactiveC2CMessage(accessToken, target.id, text);
        return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
      } else if (target.type === "group") {
        const result = await sendProactiveGroupMessage(accessToken, target.id, text);
        return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
      } else {
        // 频道暂不支持主动消息
        const result = await sendChannelMessage(accessToken, target.id, text);
        return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
      }
    }

    // 有 replyToId，使用被动回复接口
    if (target.type === "c2c") {
      const result = await sendC2CMessage(accessToken, target.id, text, replyToId);
      // 记录回复次数
      recordMessageReply(replyToId);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } else if (target.type === "group") {
      const result = await sendGroupMessage(accessToken, target.id, text, replyToId);
      // 记录回复次数
      recordMessageReply(replyToId);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } else {
      const result = await sendChannelMessage(accessToken, target.id, text, replyToId);
      // 记录回复次数
      recordMessageReply(replyToId);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "qqbot", error: message };
  }
}

/**
 * 主动发送消息（不需要 replyToId，有配额限制：每月 4 条/用户/群）
 * 
 * @param account - 账户配置
 * @param to - 目标地址，格式：openid（单聊）或 group:xxx（群聊）
 * @param text - 消息内容
 */
export async function sendProactiveMessage(
  account: ResolvedQQBotAccount,
  to: string,
  text: string
): Promise<OutboundResult> {
  const timestamp = new Date().toISOString();
  
  if (!account.appId || !account.clientSecret) {
    const errorMsg = "QQBot not configured (missing appId or clientSecret)";
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: ${errorMsg}`);
    return { channel: "qqbot", error: errorMsg };
  }

  console.log(`[${timestamp}] [qqbot] sendProactiveMessage: starting, to=${to}, text length=${text.length}, accountId=${account.accountId}`);

  try {
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: getting access token for appId=${account.appId}`);
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: parsing target=${to}`);
    const target = parseTarget(to);
    console.log(`[${timestamp}] [qqbot] sendProactiveMessage: target parsed, type=${target.type}, id=${target.id}`);

    if (target.type === "c2c") {
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: sending proactive C2C message to user=${target.id}`);
      const result = await sendProactiveC2CMessage(accessToken, target.id, text);
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: proactive C2C message sent successfully, messageId=${result.id}`);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } else if (target.type === "group") {
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: sending proactive group message to group=${target.id}`);
      const result = await sendProactiveGroupMessage(accessToken, target.id, text);
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: proactive group message sent successfully, messageId=${result.id}`);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    } else {
      // 频道暂不支持主动消息，使用普通发送
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: sending channel message to channel=${target.id}`);
      const result = await sendChannelMessage(accessToken, target.id, text);
      console.log(`[${timestamp}] [qqbot] sendProactiveMessage: channel message sent successfully, messageId=${result.id}`);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: error: ${errorMessage}`);
    console.error(`[${timestamp}] [qqbot] sendProactiveMessage: error stack: ${err instanceof Error ? err.stack : 'No stack trace'}`);
    return { channel: "qqbot", error: errorMessage };
  }
}

/**
 * 发送富媒体消息（图片）
 * 
 * 支持以下 mediaUrl 格式：
 * - 公网 URL: https://example.com/image.png
 * - Base64 Data URL: data:image/png;base64,xxxxx
 * - 本地文件路径: /path/to/image.png（自动读取并转换为 Base64）
 * 
 * @param ctx - 发送上下文，包含 mediaUrl
 * @returns 发送结果
 * 
 * @example
 * ```typescript
 * // 发送网络图片
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "https://example.com/image.png",
 *   account,
 *   replyToId: msgId,
 * });
 * 
 * // 发送 Base64 图片
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "data:image/png;base64,iVBORw0KGgo...",
 *   account,
 *   replyToId: msgId,
 * });
 * 
 * // 发送本地文件（自动读取并转换为 Base64）
 * const result = await sendMedia({
 *   to: "group:xxx",
 *   text: "这是图片说明",
 *   mediaUrl: "/tmp/generated-chart.png",
 *   account,
 *   replyToId: msgId,
 * });
 * ```
 */
export async function sendMedia(ctx: MediaOutboundContext): Promise<OutboundResult> {
  const { to, text, replyToId, account } = ctx;
  const { mediaUrl } = ctx;

  if (!account.appId || !account.clientSecret) {
    return { channel: "qqbot", error: "QQBot not configured (missing appId or clientSecret)" };
  }

  if (!mediaUrl) {
    return { channel: "qqbot", error: "mediaUrl is required for sendMedia" };
  }

  // 验证 mediaUrl 格式：支持公网 URL、Base64 Data URL 或本地文件路径
  const isHttpUrl = mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://");
  const isDataUrl = mediaUrl.startsWith("data:");
  const isLocalPath = mediaUrl.startsWith("/") || 
                      /^[a-zA-Z]:[\\/]/.test(mediaUrl) ||
                      mediaUrl.startsWith("./") ||
                      mediaUrl.startsWith("../");
  
  // 处理本地文件路径：读取文件并转换为 Base64 Data URL
  let processedMediaUrl = mediaUrl;
  
  if (isLocalPath) {
    console.log(`[qqbot] sendMedia: local file path detected: ${mediaUrl}`);
    
    try {
      // 检查文件是否存在
      if (!fs.existsSync(mediaUrl)) {
        return { 
          channel: "qqbot", 
          error: `本地文件不存在: ${mediaUrl}` 
        };
      }
      
      // 读取文件内容
      const fileBuffer = fs.readFileSync(mediaUrl);
      const base64Data = fileBuffer.toString("base64");
      
      // 根据文件扩展名确定 MIME 类型
      const ext = path.extname(mediaUrl).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
      };
      
      const mimeType = mimeTypes[ext];
      if (!mimeType) {
        return { 
          channel: "qqbot", 
          error: `不支持的图片格式: ${ext}。支持的格式: ${Object.keys(mimeTypes).join(", ")}` 
        };
      }
      
      // 构造 Data URL
      processedMediaUrl = `data:${mimeType};base64,${base64Data}`;
      console.log(`[qqbot] sendMedia: local file converted to Base64 (size: ${fileBuffer.length} bytes, type: ${mimeType})`);
      
    } catch (readErr) {
      const errMsg = readErr instanceof Error ? readErr.message : String(readErr);
      console.error(`[qqbot] sendMedia: failed to read local file: ${errMsg}`);
      return { 
        channel: "qqbot", 
        error: `读取本地文件失败: ${errMsg}` 
      };
    }
  } else if (!isHttpUrl && !isDataUrl) {
    console.log(`[qqbot] sendMedia: unsupported media format: ${mediaUrl.slice(0, 50)}`);
    return { 
      channel: "qqbot", 
      error: `不支持的图片格式: ${mediaUrl.slice(0, 50)}...。支持的格式: 公网 URL (http/https)、Base64 Data URL (data:image/...) 或本地文件路径。` 
    };
  } else if (isDataUrl) {
    console.log(`[qqbot] sendMedia: sending Base64 image (length: ${mediaUrl.length})`);
  } else {
    console.log(`[qqbot] sendMedia: sending image URL: ${mediaUrl.slice(0, 80)}...`);
  }

  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    const target = parseTarget(to);

    // 先发送图片（使用处理后的 URL，可能是 Base64 Data URL）
    let imageResult: { id: string; timestamp: number | string };
    if (target.type === "c2c") {
      imageResult = await sendC2CImageMessage(
        accessToken,
        target.id,
        processedMediaUrl,
        replyToId ?? undefined,
        undefined // content 参数，图片消息不支持同时带文本
      );
    } else if (target.type === "group") {
      imageResult = await sendGroupImageMessage(
        accessToken,
        target.id,
        processedMediaUrl,
        replyToId ?? undefined,
        undefined
      );
    } else {
      // 频道暂不支持富媒体消息，只发送文本 + URL（本地文件路径无法在频道展示）
      const displayUrl = isLocalPath ? "[本地文件]" : mediaUrl;
      const textWithUrl = text ? `${text}\n${displayUrl}` : displayUrl;
      const result = await sendChannelMessage(accessToken, target.id, textWithUrl, replyToId ?? undefined);
      return { channel: "qqbot", messageId: result.id, timestamp: result.timestamp };
    }

    // 如果有文本说明，再发送一条文本消息
    if (text?.trim()) {
      try {
        if (target.type === "c2c") {
          await sendC2CMessage(accessToken, target.id, text, replyToId ?? undefined);
        } else if (target.type === "group") {
          await sendGroupMessage(accessToken, target.id, text, replyToId ?? undefined);
        }
      } catch (textErr) {
        // 文本发送失败不影响整体结果，图片已发送成功
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
 * 
 * 当 OpenClaw cron 任务触发时，消息内容可能是：
 * 1. QQBOT_CRON:{base64} 格式的结构化载荷 - 解码后根据 targetType 和 targetAddress 发送
 * 2. 普通文本 - 直接发送到指定目标
 * 
 * @param account - 账户配置
 * @param to - 目标地址（作为后备，如果载荷中没有指定）
 * @param message - 消息内容（可能是 QQBOT_CRON: 格式或普通文本）
 * @returns 发送结果
 * 
 * @example
 * ```typescript
 * // 处理结构化载荷
 * const result = await sendCronMessage(
 *   account,
 *   "user_openid",  // 后备地址
 *   "QQBOT_CRON:eyJ0eXBlIjoiY3Jvbl9yZW1pbmRlciIs..."  // Base64 编码的载荷
 * );
 * 
 * // 处理普通文本
 * const result = await sendCronMessage(
 *   account,
 *   "user_openid",
 *   "这是一条普通的提醒消息"
 * );
 * ```
 */
export async function sendCronMessage(
  account: ResolvedQQBotAccount,
  to: string,
  message: string
): Promise<OutboundResult> {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [qqbot] sendCronMessage: to=${to}, message length=${message.length}`);
  
  // 检测是否是 QQBOT_CRON: 格式的结构化载荷
  const cronResult = decodeCronPayload(message);
  
  if (cronResult.isCronPayload) {
    if (cronResult.error) {
      console.error(`[${timestamp}] [qqbot] sendCronMessage: cron payload decode error: ${cronResult.error}`);
      return {
        channel: "qqbot",
        error: `Cron 载荷解码失败: ${cronResult.error}`
      };
    }
    
    if (cronResult.payload) {
      const payload = cronResult.payload;
      console.log(`[${timestamp}] [qqbot] sendCronMessage: decoded cron payload, targetType=${payload.targetType}, targetAddress=${payload.targetAddress}, content length=${payload.content.length}`);
      
      // 使用载荷中的目标地址和类型发送消息
      const targetTo = payload.targetType === "group" 
        ? `group:${payload.targetAddress}` 
        : payload.targetAddress;
      
      console.log(`[${timestamp}] [qqbot] sendCronMessage: sending proactive message to targetTo=${targetTo}`);
      
      // 发送提醒内容
      const result = await sendProactiveMessage(account, targetTo, payload.content);
      
      if (result.error) {
        console.error(`[${timestamp}] [qqbot] sendCronMessage: proactive message failed, error=${result.error}`);
      } else {
        console.log(`[${timestamp}] [qqbot] sendCronMessage: proactive message sent successfully`);
      }
      
      return result;
    }
  }
  
  // 非结构化载荷，作为普通文本处理
  console.log(`[${timestamp}] [qqbot] sendCronMessage: plain text message, sending to ${to}`);
  return await sendProactiveMessage(account, to, message);
}
