/**
 * QQ Bot API 鉴权和请求封装
 */

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

let cachedToken: { token: string; expiresAt: number } | null = null;

// HTTP 代理支持
let currentProxyUrl: string | undefined;
let proxyDispatcher: Dispatcher | undefined;

/**
 * 设置 HTTP 代理地址
 */
export function setProxyUrl(url?: string): void {
  currentProxyUrl = url;
  proxyDispatcher = url ? new ProxyAgent(url) : undefined;
}

/**
 * 获取当前代理 URL
 */
export function getProxyUrl(): string | undefined {
  return currentProxyUrl;
}

/**
 * 代理感知的 fetch 封装
 */
async function proxyFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  if (proxyDispatcher) {
    const res = await undiciFetch(url, { ...init as any, dispatcher: proxyDispatcher });
    return res as unknown as Response;
  }
  return fetch(url, init);
}

/**
 * 获取 AccessToken（带缓存）
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  // 检查缓存，提前 5 分钟刷新
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) {
    return cachedToken.token;
  }

  const response = await proxyFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, clientSecret }),
  });

  const data = (await response.json()) as { access_token?: string; expires_in?: number };

  if (!data.access_token) {
    throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  };

  return cachedToken.token;
}

/**
 * 清除 Token 缓存
 */
export function clearTokenCache(): void {
  cachedToken = null;
}

/**
 * msg_seq 追踪器 - 用于对同一条消息的多次回复
 * key: msg_id, value: 当前 seq 值
 */
const msgSeqTracker = new Map<string, number>();

/**
 * 获取并递增消息序号
 */
export function getNextMsgSeq(msgId: string): number {
  const current = msgSeqTracker.get(msgId) ?? 0;
  const next = current + 1;
  msgSeqTracker.set(msgId, next);
  
  // 清理过期的序号（超过 5 次或 60 分钟后无意义）
  // 简单策略：保留最近 1000 条
  if (msgSeqTracker.size > 1000) {
    const keys = Array.from(msgSeqTracker.keys());
    for (let i = 0; i < 500; i++) {
      msgSeqTracker.delete(keys[i]);
    }
  }
  
  return next;
}

/**
 * API 请求封装
 */
export async function apiRequest<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `QQBot ${accessToken}`,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await proxyFetch(url, options);
  const data = (await res.json()) as T;

  if (!res.ok) {
    const error = data as { message?: string; code?: number };
    throw new Error(`API Error [${path}]: ${error.message ?? JSON.stringify(data)}`);
  }

  return data;
}

/**
 * 获取 WebSocket Gateway URL
 */
export async function getGatewayUrl(accessToken: string): Promise<string> {
  const data = await apiRequest<{ url: string }>(accessToken, "GET", "/gateway");
  return data.url;
}

/**
 * 发送 C2C 单聊消息
 */
export async function sendC2CMessage(
  accessToken: string,
  openid: string,
  content: string,
  msgId?: string
): Promise<{ id: string; timestamp: number }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, {
    content,
    msg_type: 0,
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

/**
 * 发送频道消息
 */
export async function sendChannelMessage(
  accessToken: string,
  channelId: string,
  content: string,
  msgId?: string
): Promise<{ id: string; timestamp: string }> {
  return apiRequest(accessToken, "POST", `/channels/${channelId}/messages`, {
    content,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

/**
 * 发送群聊消息
 */
export async function sendGroupMessage(
  accessToken: string,
  groupOpenid: string,
  content: string,
  msgId?: string
): Promise<{ id: string; timestamp: string }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, {
    content,
    msg_type: 0,
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

/**
 * 主动发送 C2C 单聊消息（不需要 msg_id，每月限 4 条/用户）
 */
export async function sendProactiveC2CMessage(
  accessToken: string,
  openid: string,
  content: string
): Promise<{ id: string; timestamp: number }> {
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, {
    content,
    msg_type: 0,
  });
}

/**
 * 主动发送群聊消息（不需要 msg_id，每月限 4 条/群）
 */
export async function sendProactiveGroupMessage(
  accessToken: string,
  groupOpenid: string,
  content: string
): Promise<{ id: string; timestamp: string }> {
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, {
    content,
    msg_type: 0,
  });
}
