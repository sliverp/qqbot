/**
 * QQ Bot 主动发送消息模块
 *
 * 该模块提供以下能力：
 * 1. 主动发送消息给用户或群组
 * 2. 批量发送 / 广播
 *
 * 用户存储统一使用 known-users.ts，不再重复实现。
 */

import type { ResolvedQQBotAccount } from "./types.js";
import {
  getAccessToken,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
  sendC2CImageMessage,
  sendGroupImageMessage,
} from "./api.js";
import { resolveQQBotAccount } from "./config.js";
import { listKnownUsers } from "./known-users.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

// ============ 类型定义 ============

/** 主动发送消息选项 */
export interface ProactiveSendOptions {
  to: string;
  text: string;
  type?: "c2c" | "group" | "channel";
  imageUrl?: string;
  accountId?: string;
}

/** 主动发送消息结果 */
export interface ProactiveSendResult {
  success: boolean;
  messageId?: string;
  timestamp?: number | string;
  error?: string;
}

// ============ 主动发送消息 ============

/**
 * 主动发送消息（带配置解析）
 * 注意：与 outbound.ts 中的 sendProactiveMessage 不同，这个函数接受 OpenClawConfig 并自动解析账户
 * 
 * @param options - 发送选项
 * @param cfg - OpenClaw 配置
 * @returns 发送结果
 * 
 * @example
 * ```typescript
 * // 发送私聊消息
 * const result = await sendProactive({
 *   to: "E7A8F3B2C1D4E5F6A7B8C9D0E1F2A3B4",  // 用户 openid
 *   text: "你好！这是一条主动消息",
 *   type: "c2c",
 * }, cfg);
 * 
 * // 发送群聊消息
 * const result = await sendProactive({
 *   to: "A1B2C3D4E5F6A7B8",  // 群组 openid
 *   text: "群公告：今天有活动",
 *   type: "group",
 * }, cfg);
 * 
 * // 发送带图片的消息
 * const result = await sendProactive({
 *   to: "E7A8F3B2C1D4E5F6A7B8C9D0E1F2A3B4",
 *   text: "看看这张图片",
 *   imageUrl: "https://example.com/image.png",
 *   type: "c2c",
 * }, cfg);
 * ```
 */
export async function sendProactive(
  options: ProactiveSendOptions,
  cfg: OpenClawConfig
): Promise<ProactiveSendResult> {
  const { to, text, type = "c2c", imageUrl, accountId = "default" } = options;
  
  // 解析账户配置
  const account = resolveQQBotAccount(cfg, accountId);
  
  if (!account.appId || !account.clientSecret) {
    return {
      success: false,
      error: "QQBot not configured (missing appId or clientSecret)",
    };
  }
  
  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    
    // 如果有图片，先发送图片
    if (imageUrl) {
      try {
        if (type === "c2c") {
          await sendC2CImageMessage(accessToken, to, imageUrl, undefined, undefined);
        } else if (type === "group") {
          await sendGroupImageMessage(accessToken, to, imageUrl, undefined, undefined);
        }
        console.log(`[qqbot:proactive] Sent image to ${type}:${to}`);
      } catch (err) {
        console.error(`[qqbot:proactive] Failed to send image: ${err}`);
        // 图片发送失败不影响文本发送
      }
    }
    
    // 发送文本消息
    let result: { id: string; timestamp: number | string };
    
    if (type === "c2c") {
      result = await sendProactiveC2CMessage(accessToken, to, text);
    } else if (type === "group") {
      result = await sendProactiveGroupMessage(accessToken, to, text);
    } else if (type === "channel") {
      // 频道消息需要 channel_id，这里暂时不支持主动发送
      return {
        success: false,
        error: "Channel proactive messages are not supported. Please use group or c2c.",
      };
    } else {
      return {
        success: false,
        error: `Unknown message type: ${type}`,
      };
    }
    
    console.log(`[qqbot:proactive] Sent message to ${type}:${to}, id: ${result.id}`);
    
    return {
      success: true,
      messageId: result.id,
      timestamp: result.timestamp,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[qqbot:proactive] Failed to send message: ${message}`);
    
    return {
      success: false,
      error: message,
    };
  }
}

/**
 * 批量发送主动消息
 * 
 * @param recipients - 接收者列表（openid 数组）
 * @param text - 消息内容
 * @param type - 消息类型
 * @param cfg - OpenClaw 配置
 * @param accountId - 账户 ID
 * @returns 发送结果列表
 */
export async function sendBulkProactiveMessage(
  recipients: string[],
  text: string,
  type: "c2c" | "group",
  cfg: OpenClawConfig,
  accountId = "default"
): Promise<Array<{ to: string; result: ProactiveSendResult }>> {
  const results: Array<{ to: string; result: ProactiveSendResult }> = [];
  
  for (const to of recipients) {
    const result = await sendProactive({ to, text, type, accountId }, cfg);
    results.push({ to, result });
    
    // 添加延迟，避免频率限制
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  return results;
}

/**
 * 发送消息给所有已知用户
 * 
 * @param text - 消息内容
 * @param cfg - OpenClaw 配置
 * @param options - 过滤选项
 * @returns 发送结果统计
 */
export async function broadcastMessage(
  text: string,
  cfg: OpenClawConfig,
  options?: {
    type?: "c2c" | "group";
    accountId?: string;
    limit?: number;
  }
): Promise<{
  total: number;
  success: number;
  failed: number;
  results: Array<{ to: string; result: ProactiveSendResult }>;
}> {
  const users = listKnownUsers({
    type: options?.type,
    accountId: options?.accountId,
    limit: options?.limit,
    sortBy: "lastSeenAt",
    sortOrder: "desc",
  });
  
  // 过滤掉频道用户（不支持主动发送）
  const validUsers = users.filter(u => u.type === "c2c" || u.type === "group");
  
  const results: Array<{ to: string; result: ProactiveSendResult }> = [];
  let success = 0;
  let failed = 0;
  
  for (const user of validUsers) {
    const result = await sendProactive({
      to: user.openid,
      text,
      type: user.type as "c2c" | "group",
      accountId: user.accountId,
    }, cfg);
    
    results.push({ to: user.openid, result });
    
    if (result.success) {
      success++;
    } else {
      failed++;
    }
    
    // 添加延迟，避免频率限制
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  return {
    total: validUsers.length,
    success,
    failed,
    results,
  };
}

// ============ 辅助函数 ============

/**
 * 根据账户配置直接发送主动消息（不需要 cfg）
 * 
 * @param account - 已解析的账户配置
 * @param to - 目标 openid
 * @param text - 消息内容
 * @param type - 消息类型
 */
export async function sendProactiveMessageDirect(
  account: ResolvedQQBotAccount,
  to: string,
  text: string,
  type: "c2c" | "group" = "c2c"
): Promise<ProactiveSendResult> {
  if (!account.appId || !account.clientSecret) {
    return {
      success: false,
      error: "QQBot not configured (missing appId or clientSecret)",
    };
  }
  
  try {
    const accessToken = await getAccessToken(account.appId, account.clientSecret);
    
    let result: { id: string; timestamp: number | string };
    
    if (type === "c2c") {
      result = await sendProactiveC2CMessage(accessToken, to, text);
    } else {
      result = await sendProactiveGroupMessage(accessToken, to, text);
    }
    
    return {
      success: true,
      messageId: result.id,
      timestamp: result.timestamp,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 获取已知用户统计（代理到 known-users 模块）
 */
export { getKnownUsersStats } from "./known-users.js";
