/**
 * 消息回复限流器
 * 同一 message_id 1小时内最多回复 4 次，超过后需降级为主动消息
 */

const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1 小时

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const tracker = new Map<string, MessageReplyRecord>();

/** 限流检查结果 */
export interface ReplyLimitResult {
  allowed: boolean;
  remaining: number;
  shouldFallbackToProactive: boolean;
  fallbackReason?: "expired" | "limit_exceeded";
  message?: string;
}

/**
 * 检查是否可以被动回复该消息
 */
export function checkMessageReplyLimit(messageId: string): ReplyLimitResult {
  const now = Date.now();

  // 清理过期记录
  if (tracker.size > 10000) {
    for (const [id, rec] of tracker) {
      if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
        tracker.delete(id);
      }
    }
  }

  const record = tracker.get(messageId);

  if (!record) {
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT, shouldFallbackToProactive: false };
  }

  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    tracker.delete(messageId);
    return {
      allowed: false,
      remaining: 0,
      shouldFallbackToProactive: true,
      fallbackReason: "expired",
      message: `消息已超过1小时有效期，将使用主动消息发送`,
    };
  }

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

  return { allowed: true, remaining, shouldFallbackToProactive: false };
}

/**
 * 记录一次消息回复
 */
export function recordMessageReply(messageId: string): void {
  const now = Date.now();
  const record = tracker.get(messageId);

  if (!record) {
    tracker.set(messageId, { count: 1, firstReplyAt: now });
  } else if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    tracker.set(messageId, { count: 1, firstReplyAt: now });
  } else {
    record.count++;
  }
}

/**
 * 获取消息回复统计
 */
export function getMessageReplyStats(): { trackedMessages: number; totalReplies: number } {
  let totalReplies = 0;
  for (const record of tracker.values()) {
    totalReplies += record.count;
  }
  return { trackedMessages: tracker.size, totalReplies };
}

/**
 * 获取限流配置
 */
export function getMessageReplyConfig(): { limit: number; ttlMs: number; ttlHours: number } {
  return {
    limit: MESSAGE_REPLY_LIMIT,
    ttlMs: MESSAGE_REPLY_TTL,
    ttlHours: MESSAGE_REPLY_TTL / (60 * 60 * 1000),
  };
}
