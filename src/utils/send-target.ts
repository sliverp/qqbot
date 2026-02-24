/**
 * 消息发送目标解析和统一发送工具
 * 消除 c2c/group/channel 三分支重复代码
 */

import {
  getAccessToken,
  clearTokenCache,
  sendC2CMessage,
  sendChannelMessage,
  sendGroupMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
  sendC2CImageMessage,
  sendGroupImageMessage,
} from "../api.js";

/** 消息发送目标类型 */
export type TargetType = "c2c" | "group" | "channel";

/** 消息发送目标 */
export interface SendTarget {
  type: TargetType;
  id: string;
}

/** 消息事件上下文（提供目标信息） */
export interface MessageEventContext {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  messageId: string;
  channelId?: string;
  groupOpenid?: string;
}

/**
 * 从消息事件推导发送目标
 */
export function targetFromEvent(event: MessageEventContext): SendTarget {
  if (event.type === "c2c" || event.type === "dm") {
    return { type: "c2c", id: event.senderId };
  }
  if (event.type === "group" && event.groupOpenid) {
    return { type: "group", id: event.groupOpenid };
  }
  if (event.channelId) {
    return { type: "channel", id: event.channelId };
  }
  return { type: "c2c", id: event.senderId };
}

/**
 * 解析目标地址字符串
 * 格式：openid / group:xxx / channel:xxx / c2c:xxx / qqbot:c2c:xxx
 */
export function parseTarget(to: string): SendTarget {
  const id = to.replace(/^qqbot:/i, "");

  if (id.startsWith("c2c:")) {
    const userId = id.slice(4);
    if (!userId) throw new Error(`Invalid c2c target: ${to}`);
    return { type: "c2c", id: userId };
  }
  if (id.startsWith("group:")) {
    const groupId = id.slice(6);
    if (!groupId) throw new Error(`Invalid group target: ${to}`);
    return { type: "group", id: groupId };
  }
  if (id.startsWith("channel:")) {
    const channelId = id.slice(8);
    if (!channelId) throw new Error(`Invalid channel target: ${to}`);
    return { type: "channel", id: channelId };
  }

  if (!id) throw new Error(`Invalid target: ${to}`);
  return { type: "c2c", id };
}

/** 消息发送结果 */
export interface MessageResult {
  id: string;
  timestamp: number | string;
}

/**
 * 发送文本消息（被动回复，需要 msgId）
 */
export async function sendTextToTarget(
  token: string,
  target: SendTarget,
  text: string,
  msgId?: string,
): Promise<MessageResult> {
  switch (target.type) {
    case "c2c":
      return sendC2CMessage(token, target.id, text, msgId);
    case "group":
      return sendGroupMessage(token, target.id, text, msgId);
    case "channel":
      return sendChannelMessage(token, target.id, text, msgId);
  }
}

/**
 * 发送主动文本消息（不需要 msgId）
 */
export async function sendProactiveTextToTarget(
  token: string,
  target: SendTarget,
  text: string,
): Promise<MessageResult> {
  switch (target.type) {
    case "c2c":
      return sendProactiveC2CMessage(token, target.id, text);
    case "group":
      return sendProactiveGroupMessage(token, target.id, text);
    case "channel":
      return sendChannelMessage(token, target.id, text);
  }
}

/**
 * 发送图片消息
 */
export async function sendImageToTarget(
  token: string,
  target: SendTarget,
  imageUrl: string,
  msgId?: string,
): Promise<MessageResult | null> {
  switch (target.type) {
    case "c2c":
      return sendC2CImageMessage(token, target.id, imageUrl, msgId);
    case "group":
      return sendGroupImageMessage(token, target.id, imageUrl, msgId);
    case "channel":
      // 频道仅支持公网 URL markdown
      if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
        return sendChannelMessage(token, target.id, `![](${imageUrl})`, msgId);
      }
      return null;
  }
}

/**
 * 带 Token 过期自动重试的发送封装
 */
export async function withTokenRetry<T>(
  appId: string,
  clientSecret: string,
  sendFn: (token: string) => Promise<T>,
): Promise<T> {
  try {
    const token = await getAccessToken(appId, clientSecret);
    return await sendFn(token);
  } catch (err) {
    const errMsg = String(err);
    if (errMsg.includes("401") || errMsg.includes("token") || errMsg.includes("access_token")) {
      clearTokenCache();
      const newToken = await getAccessToken(appId, clientSecret);
      return await sendFn(newToken);
    }
    throw err;
  }
}
