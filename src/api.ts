/**
 * QQ Bot API 鉴权和请求封装
 * [修复版] 已重构为支持多实例并发，消除全局变量冲突
 */

import os from "node:os";
import { computeFileHash, getCachedFileInfo, setCachedFileInfo } from "./utils/upload-cache.js";
import { sanitizeFileName } from "./utils/platform.js";

// ============ 自定义错误 ============

/** API 请求错误，携带 HTTP status code 和业务错误码 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
    /** 业务错误码（回包中的 code / err_code 字段），不一定存在 */
    public readonly bizCode?: number,
    /** 回包中的原始 message 字段（用于向用户展示兜底文案） */
    public readonly bizMessage?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

// ============ Plugin User-Agent ============
// 格式: QQBotPlugin/{version} (Node/{nodeVersion}; {os})
// 示例: QQBotPlugin/1.6.0 (Node/22.14.0; darwin)
import { getPackageVersion } from "./utils/pkg-version.js";
const _pluginVersion = getPackageVersion(import.meta.url);
export const PLUGIN_USER_AGENT = `QQBotPlugin/${_pluginVersion} (Node/${process.versions.node}; ${os.platform()})`;

// 运行时配置
let currentMarkdownSupport = false;

// 出站消息回调钩子：消息发送成功且回包含 ext_info.ref_idx 时触发
// 由外层（gateway/outbound）注册，用于统一缓存 bot 出站消息的 refIdx

/** 出站消息元信息（结构化存储，不做预格式化） */
export interface OutboundMeta {
  /** 消息文本内容 */
  text?: string;
  /** 媒体类型 */
  mediaType?: "image" | "voice" | "video" | "file";
  /** 媒体来源：在线 URL */
  mediaUrl?: string;
  /** 媒体来源：本地文件路径或文件名 */
  mediaLocalPath?: string;
  /** TTS 原文本（仅 voice 类型有效，用于保存 TTS 前的文本内容） */
  ttsText?: string;
}

type OnMessageSentCallback = (refIdx: string, meta: OutboundMeta) => void;
let onMessageSentHook: OnMessageSentCallback | null = null;

/**
 * 注册出站消息回调
 * 当消息发送成功且 QQ 返回 ref_idx 时，自动回调此函数
 * 用于在最底层统一缓存 bot 出站消息的 refIdx
 */
export function onMessageSent(callback: OnMessageSentCallback): void {
  onMessageSentHook = callback;
}

/**
 * 初始化 API 配置
 */
export function initApiConfig(options: { markdownSupport?: boolean }): void {
  currentMarkdownSupport = options.markdownSupport === true;
}

/**
 * 获取当前是否支持 markdown
 */
export function isMarkdownSupport(): boolean {
  return currentMarkdownSupport;
}

// =========================================================================
// 🚀 [核心修复] 将全局状态改为 Map，按 appId 隔离，彻底解决多账号串号问题
// =========================================================================
const tokenCacheMap = new Map<string, { token: string; expiresAt: number; appId: string }>();
const tokenFetchPromises = new Map<string, Promise<string>>();

/**
 * 获取 AccessToken（带缓存 + singleflight 并发安全）
 * 
 * 使用 singleflight 模式：当多个请求同时发现 Token 过期时，
 * 只有第一个请求会真正去获取新 Token，其他请求复用同一个 Promise。
 * 
 * 按 appId 隔离，支持多机器人并发请求。
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  const normalizedAppId = String(appId).trim();
  const cachedToken = tokenCacheMap.get(normalizedAppId);

  // 检查缓存：未过期时复用
  // 提前刷新阈值：取 expiresIn 的 1/3 和 5 分钟的较小值，避免短有效期 token 永远被判定过期
  const REFRESH_AHEAD_MS = cachedToken
    ? Math.min(5 * 60 * 1000, (cachedToken.expiresAt - Date.now()) / 3)
    : 0;
  if (cachedToken && Date.now() < cachedToken.expiresAt - REFRESH_AHEAD_MS) {
    return cachedToken.token;
  }

  // Singleflight: 如果当前 appId 已有进行中的 Token 获取请求，复用它
  let fetchPromise = tokenFetchPromises.get(normalizedAppId);
  if (fetchPromise) {
    console.log(`[qqbot-api:${normalizedAppId}] Token fetch in progress, waiting for existing request...`);
    return fetchPromise;
  }

  // 创建新的 Token 获取 Promise（singleflight 入口）
  fetchPromise = (async () => {
    try {
      return await doFetchToken(normalizedAppId, clientSecret);
    } finally {
      // 无论成功失败，都清除 Promise 缓存
      tokenFetchPromises.delete(normalizedAppId);
    }
  })();

  tokenFetchPromises.set(normalizedAppId, fetchPromise);
  return fetchPromise;
}

/**
 * 实际执行 Token 获取的内部函数
 */
async function doFetchToken(appId: string, clientSecret: string): Promise<string> {
  const requestBody = { appId, clientSecret };
  const requestHeaders = { "Content-Type": "application/json", "User-Agent": PLUGIN_USER_AGENT };
  
  // 打印请求信息（隐藏敏感信息）
  console.log(`[qqbot-api:${appId}] >>> POST ${TOKEN_URL} [secret: ${clientSecret.slice(0, 6)}...len=${clientSecret.length}]`);

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    console.error(`[qqbot-api:${appId}] <<< Network error:`, err);
    throw new Error(`Network error getting access_token: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 打印响应头
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const tokenTraceId = response.headers.get("x-tps-trace-id") ?? "";
  console.log(`[qqbot-api:${appId}] <<< Status: ${response.status} ${response.statusText}${tokenTraceId ? ` | TraceId: ${tokenTraceId}` : ""}`);

  let data: { access_token?: string; expires_in?: number };
  let rawBody: string;
  try {
    rawBody = await response.text();
    // 隐藏 token 值
    const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"');
    console.log(`[qqbot-api:${appId}] <<< Body:`, logBody);
    data = JSON.parse(rawBody) as { access_token?: string; expires_in?: number };
  } catch (err) {
    console.error(`[qqbot-api:${appId}] <<< Parse error:`, err);
    throw new Error(`Failed to parse access_token response: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!data.access_token) {
    throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
  }

  const expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
  
  tokenCacheMap.set(appId, {
    token: data.access_token,
    expiresAt,
    appId,
  });

  console.log(`[qqbot-api:${appId}] Token cached, expires at: ${new Date(expiresAt).toISOString()}`);
  return data.access_token;
}

/**
 * 清除 Token 缓存
 * @param appId 选填。如果有，只清空特定账号的缓存；如果没有，清空所有账号。
 */
export function clearTokenCache(appId?: string): void {
  if (appId) {
    const normalizedAppId = String(appId).trim();
    tokenCacheMap.delete(normalizedAppId);
    console.log(`[qqbot-api:${normalizedAppId}] Token cache cleared manually.`);
  } else {
    tokenCacheMap.clear();
    console.log(`[qqbot-api] All token caches cleared.`);
  }
}

/**
 * 获取 Token 缓存状态（用于监控）
 */
export function getTokenStatus(appId: string): { status: "valid" | "expired" | "refreshing" | "none"; expiresAt: number | null } {
  if (tokenFetchPromises.has(appId)) {
    return { status: "refreshing", expiresAt: tokenCacheMap.get(appId)?.expiresAt ?? null };
  }
  const cached = tokenCacheMap.get(appId);
  if (!cached) {
    return { status: "none", expiresAt: null };
  }
  const remaining = cached.expiresAt - Date.now();
  const isValid = remaining > Math.min(5 * 60 * 1000, remaining / 3);
  return { status: isValid ? "valid" : "expired", expiresAt: cached.expiresAt };
}

/**
 * 获取全局唯一的消息序号（范围 0 ~ 65535）
 * 使用毫秒级时间戳低位 + 随机数异或混合，无状态，避免碰撞
 */
export function getNextMsgSeq(_msgId: string): number {
  const timePart = Date.now() % 100000000; // 毫秒时间戳后8位
  const random = Math.floor(Math.random() * 65536); // 0~65535
  return (timePart ^ random) % 65536; // 异或混合后限制在 0~65535
}

// API 请求超时配置（毫秒）
const DEFAULT_API_TIMEOUT = 30000; // 默认 30 秒
const FILE_UPLOAD_TIMEOUT = 120000; // 文件上传 120 秒

/**
 * API 请求封装
 */
export async function apiRequest<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `QQBot ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": PLUGIN_USER_AGENT,
  };
  
  const isFileUpload = path.includes("/files");
  const timeout = timeoutMs ?? (isFileUpload ? FILE_UPLOAD_TIMEOUT : DEFAULT_API_TIMEOUT);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeout);
  
  const options: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  // 打印请求信息
  console.log(`[qqbot-api] >>> ${method} ${url} (timeout: ${timeout}ms)`);
  if (body) {
    const logBody = { ...body } as Record<string, unknown>;
    if (typeof logBody.file_data === "string") {
      logBody.file_data = `<base64 ${(logBody.file_data as string).length} chars>`;
    }
    console.log(`[qqbot-api] >>> Body:`, JSON.stringify(logBody));
  }

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[qqbot-api] <<< Request timeout after ${timeout}ms`);
      throw new Error(`Request timeout[${path}]: exceeded ${timeout}ms`);
    }
    console.error(`[qqbot-api] <<< Network error:`, err);
    throw new Error(`Network error [${path}]: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const traceId = res.headers.get("x-tps-trace-id") ?? "";
  console.log(`[qqbot-api] <<< Status: ${res.status} ${res.statusText}${traceId ? ` | TraceId: ${traceId}` : ""}`);

  let rawBody: string;
  try {
    rawBody = await res.text();
  } catch (err) {
    throw new Error(`读取响应失败[${path}]: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`[qqbot-api] <<< Body:`, rawBody);

  // 检测非 JSON 响应（HTML 网关错误页 / CDN 限流页等）
  const contentType = res.headers.get("content-type") ?? "";
  const isHtmlResponse = contentType.includes("text/html") || rawBody.trimStart().startsWith("<");

  if (!res.ok) {
    if (isHtmlResponse) {
      // HTML 响应 = 网关/限流层返回的错误页，给出友好提示
      const statusHint = res.status === 502 || res.status === 503 || res.status === 504
        ? "调用发生异常，请稍候重试"
        : res.status === 429
          ? "请求过于频繁，已被限流"
          : `开放平台返回 HTTP ${res.status}`;
      throw new ApiError(`${statusHint}（${path}），请稍后重试`, res.status, path);
    }
    // JSON 错误响应
    try {
      const error = JSON.parse(rawBody) as { message?: string; code?: number; err_code?: number };
      const bizCode = error.code ?? error.err_code;
      throw new ApiError(`API Error [${path}]: ${error.message ?? rawBody}`, res.status, path, bizCode, error.message);
    } catch (parseErr) {
      if (parseErr instanceof ApiError) throw parseErr;
      throw new ApiError(`API Error [${path}] HTTP ${res.status}: ${rawBody.slice(0, 200)}`, res.status, path);
    }
  }

  // 成功响应但不是 JSON（极端异常情况）
  if (isHtmlResponse) {
    throw new Error(`QQ 服务端返回了非 JSON 响应（${path}），可能是临时故障，请稍后重试`);
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new Error(`开放平台响应格式异常（${path}），请稍后重试`);
  }
}

// ============ 上传重试（指数退避） ============

const UPLOAD_MAX_RETRIES = 2;
const UPLOAD_BASE_DELAY_MS = 1000;

async function apiRequestWithRetry<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  maxRetries = UPLOAD_MAX_RETRIES,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await apiRequest<T>(accessToken, method, path, body);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      
      const errMsg = lastError.message;
      if (
        errMsg.includes("400") || errMsg.includes("401") || errMsg.includes("Invalid") ||
        errMsg.includes("上传超时") || errMsg.includes("timeout") || errMsg.includes("Timeout")
      ) {
        throw lastError;
      }

      if (attempt < maxRetries) {
        const delay = UPLOAD_BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`[qqbot-api] Upload attempt ${attempt + 1} failed, retrying in ${delay}ms: ${errMsg.slice(0, 100)}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

// ============ 完成上传重试（无条件，任何错误都重试） ============

const COMPLETE_UPLOAD_MAX_RETRIES = 2;
const COMPLETE_UPLOAD_BASE_DELAY_MS = 2000;

/**
 * 完成上传专用重试：无条件重试所有错误（包括 4xx、5xx、网络错误、超时等）
 * 分片上传完成接口的失败往往是平台侧异步处理未就绪，重试通常能成功
 */
async function completeUploadWithRetry(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<MediaUploadResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= COMPLETE_UPLOAD_MAX_RETRIES; attempt++) {
    try {
      return await apiRequest<MediaUploadResponse>(accessToken, method, path, body);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < COMPLETE_UPLOAD_MAX_RETRIES) {
        const delay = COMPLETE_UPLOAD_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[qqbot-api] CompleteUpload attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message.slice(0, 200)}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

// ============ 分片完成重试 ============

/** 普通错误最大重试次数 */
const PART_FINISH_MAX_RETRIES = 2;
const PART_FINISH_BASE_DELAY_MS = 1000;

/**
 * 需要持续重试的业务错误码集合
 * 当 upload_part_finish 返回这些错误码时，会以固定 1s 间隔持续重试直到成功或超时
 */
export const PART_FINISH_RETRYABLE_CODES: Set<number> = new Set([
  40093001,
]);

/**
 * upload_prepare 接口命中此错误码时，携带文件信息抛出 UploadDailyLimitExceededError，
 * 由上层（outbound.ts）构造包含文件路径和大小的兜底文案发送给用户，
 * 而非走通用的"文件发送失败，请稍后重试"
 */
export const UPLOAD_PREPARE_FALLBACK_CODE = 40093002;

/** 特定错误码持续重试的默认超时（服务端未返回 retry_timeout 时的兜底） */
const PART_FINISH_RETRYABLE_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

/** 特定错误码重试的固定间隔（1 秒） */
const PART_FINISH_RETRYABLE_INTERVAL_MS = 1000;

/**
 * 判断错误是否命中"需要持续重试"的业务错误码
 */
function isRetryableBizCode(err: unknown): boolean {
  if (PART_FINISH_RETRYABLE_CODES.size === 0) return false;
  if (err instanceof ApiError && err.bizCode !== undefined) {
    return PART_FINISH_RETRYABLE_CODES.has(err.bizCode);
  }
  return false;
}

/**
 * 分片完成接口重试策略：
 * 
 * 1. 命中 PART_FINISH_RETRYABLE_CODES 的错误码 → 每 1s 重试一次，直到成功或超时
 *    超时时间 = min(API 返回的 retry_timeout, 10 分钟)
 * 2. 其他错误 → 最多重试 PART_FINISH_MAX_RETRIES 次（与之前逻辑一致）
 * 
 * 若持续重试超时或普通重试耗尽，抛出错误，调用方（chunkedUpload）
 * 可据此中止后续分片上传。
 * 
 * @param retryTimeoutMs - 持续重试的超时时间（毫秒），由 upload_prepare 返回的 retry_timeout 计算得出
 */
async function partFinishWithRetry(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  retryTimeoutMs?: number,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= PART_FINISH_MAX_RETRIES; attempt++) {
    try {
      await apiRequest<Record<string, unknown>>(accessToken, method, path, body);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // 命中特定错误码 → 进入持续重试模式
      if (isRetryableBizCode(err)) {
        const timeoutMs = retryTimeoutMs ?? PART_FINISH_RETRYABLE_DEFAULT_TIMEOUT_MS;
        console.warn(`[qqbot-api] PartFinish hit retryable bizCode=${(err as ApiError).bizCode}, entering persistent retry (timeout=${timeoutMs / 1000}s, interval=1s)...`);
        await partFinishPersistentRetry(accessToken, method, path, body, timeoutMs);
        return;
      }

      if (attempt < PART_FINISH_MAX_RETRIES) {
        const delay = PART_FINISH_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[qqbot-api] PartFinish attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message.slice(0, 200)}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

/**
 * 特定错误码的持续重试模式
 * 不限次数，仅受总超时时间约束，固定每 1 秒重试一次
 */
async function partFinishPersistentRetry(
  accessToken: string,
  method: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      await apiRequest<Record<string, unknown>>(accessToken, method, path, body);
      console.log(`[qqbot-api] PartFinish persistent retry succeeded after ${attempt} retries`);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // 如果不再是可重试的错误码，直接抛出（可能是其他类型的错误）
      if (!isRetryableBizCode(err)) {
        console.error(`[qqbot-api] PartFinish persistent retry: error is no longer retryable (bizCode=${(err as ApiError).bizCode ?? "N/A"}), aborting`);
        throw lastError;
      }

      attempt++;
      const remaining = deadline - Date.now();

      if (remaining <= 0) break;

      const actualDelay = Math.min(PART_FINISH_RETRYABLE_INTERVAL_MS, remaining);
      console.warn(`[qqbot-api] PartFinish persistent retry #${attempt}: bizCode=${(err as ApiError).bizCode}, retrying in ${actualDelay}ms (remaining=${Math.round(remaining / 1000)}s)`);
      await new Promise(resolve => setTimeout(resolve, actualDelay));
    }
  }

  // 超时
  console.error(`[qqbot-api] PartFinish persistent retry timed out after ${timeoutMs / 1000}s (${attempt} attempts)`);
  throw new Error(`upload_part_finish 持续重试超时（${timeoutMs / 1000}s, ${attempt} 次重试），中止上传`);
}

export async function getGatewayUrl(accessToken: string): Promise<string> {
  const data = await apiRequest<{ url: string }>(accessToken, "GET", "/gateway");
  return data.url;
}

/** 回应按钮交互（INTERACTION_CREATE），避免客户端按钮持续 loading */
export async function acknowledgeInteraction(
  accessToken: string,
  interactionId: string,
  code: 0 | 1 | 2 | 3 | 4 | 5 = 0,
  data?: Record<string, unknown>
): Promise<void> {
  await apiRequest(accessToken, "PUT", `/interactions/${interactionId}`, { code, ...(data ? { data } : {}) });
}

/** 获取插件版本号（从 package.json 读取，和 PLUGIN_USER_AGENT 同源） */
export function getApiPluginVersion(): string {
  return _pluginVersion;
}

// ============ 消息发送接口 ============

export interface MessageResponse {
  id: string;
  timestamp: number | string;
  /** 消息的引用索引信息（出站时由 QQ 服务端返回） */
  ext_info?: {
    ref_idx?: string;
  };
}

/**
 * 发送消息并自动触发 refIdx 回调
 * 所有消息发送函数统一经过此处，确保每条出站消息的 refIdx 都被捕获
 */
async function sendAndNotify(
  accessToken: string,
  method: string,
  path: string,
  body: unknown,
  meta: OutboundMeta,
): Promise<MessageResponse> {
  const result = await apiRequest<MessageResponse>(accessToken, method, path, body);
  if (result.ext_info?.ref_idx && onMessageSentHook) {
    try {
      onMessageSentHook(result.ext_info.ref_idx, meta);
    } catch (err) {
      console.error(`[qqbot-api] onMessageSent hook error: ${err}`);
    }
  }
  return result;
}

function buildMessageBody(
  content: string,
  msgId: string | undefined,
  msgSeq: number,
  messageReference?: string
): Record<string, unknown> {
  const body: Record<string, unknown> = currentMarkdownSupport
    ? {
        markdown: { content },
        msg_type: 2,
        msg_seq: msgSeq,
      }
    : {
        content,
        msg_type: 0,
        msg_seq: msgSeq,
      };

  if (msgId) {
    body.msg_id = msgId;
  }
  if (messageReference && !currentMarkdownSupport) {
    body.message_reference = { message_id: messageReference };
  }
  return body;
}

export async function sendC2CMessage(
  accessToken: string,
  openid: string,
  content: string,
  msgId?: string,
  messageReference?: string
): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = buildMessageBody(content, msgId, msgSeq, messageReference);
  return sendAndNotify(accessToken, "POST", `/v2/users/${openid}/messages`, body, { text: content });
}

export async function sendC2CInputNotify(
  accessToken: string,
  openid: string,
  msgId?: string,
  inputSecond: number = 60
): Promise<{ refIdx?: string }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = {
    msg_type: 6,
    input_notify: {
      input_type: 1,
      input_second: inputSecond,
    },
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  };
  const response = await apiRequest<{ ext_info?: { ref_idx?: string } }>(accessToken, "POST", `/v2/users/${openid}/messages`, body);
  return { refIdx: response.ext_info?.ref_idx };
}

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
 * 发送频道私信消息
 * @param guildId - 私信会话的 guild_id（由 DIRECT_MESSAGE_CREATE 事件提供）
 * @param msgId - 被动回复时必填
 */
export async function sendDmMessage(
  accessToken: string,
  guildId: string,
  content: string,
  msgId?: string
): Promise<{ id: string; timestamp: string }> {
  return apiRequest(accessToken, "POST", `/dms/${guildId}/messages`, {
    content,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

export async function sendGroupMessage(
  accessToken: string,
  groupOpenid: string,
  content: string,
  msgId?: string,
  messageReference?: string
): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = buildMessageBody(content, msgId, msgSeq, messageReference);
  return sendAndNotify(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body, { text: content });
}

function buildProactiveMessageBody(content: string): Record<string, unknown> {
  if (!content || content.trim().length === 0) {
    throw new Error("主动消息内容不能为空 (markdown.content is empty)");
  }
  if (currentMarkdownSupport) {
    return { markdown: { content }, msg_type: 2 };
  } else {
    return { content, msg_type: 0 };
  }
}

export async function sendProactiveC2CMessage(
  accessToken: string,
  openid: string,
  content: string
): Promise<MessageResponse> {
  const body = buildProactiveMessageBody(content);
  return sendAndNotify(accessToken, "POST", `/v2/users/${openid}/messages`, body, { text: content });
}

export async function sendProactiveGroupMessage(
  accessToken: string,
  groupOpenid: string,
  content: string
): Promise<{ id: string; timestamp: string }> {
  const body = buildProactiveMessageBody(content);
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body);
}

// ============ 富媒体消息支持 ============

export enum MediaFileType {
  IMAGE = 1,
  VIDEO = 2,
  VOICE = 3,
  FILE = 4,
}

export interface UploadMediaResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
  id?: string;
}

// ============ 大文件分片上传 API ============

/** 分片信息 */
export interface UploadPart {
  /** 分片索引（从 1 开始） */
  index: number;
  /** 预签名上传链接 */
  presigned_url: string;
}

/** 申请上传响应 */
export interface UploadPrepareResponse {
  /** 上传任务 ID */
  upload_id: string;
  /** 分块大小（字节） */
  block_size: number;
  /** 分片列表（含预签名链接） */
  parts: UploadPart[];
  /** 上传并发数（由服务端控制，可选，不返回时使用客户端默认值） */
  concurrency?: number;
  /** upload_part_finish 特定错误码的重试超时时间（秒），由服务端控制，客户端上限 10 分钟 */
  retry_timeout?: number;
}

/** 完成文件上传响应（与 UploadMediaResponse 一致） */
export interface MediaUploadResponse {
  /** 文件 UUID */
  file_uuid: string;
  /** 文件信息（用于发送消息），是 InnerUploadRsp 的序列化 */
  file_info: string;
  /** 文件信息过期时长（秒） */
  ttl: number;
}

/** 申请上传时的文件哈希信息 */
export interface UploadPrepareHashes {
  /** 整个文件的 MD5（十六进制） */
  md5: string;
  /** 整个文件的 SHA1（十六进制） */
  sha1: string;
  /** 文件前 10002432 Bytes 的 MD5（十六进制）；文件不足该大小时为整文件 MD5 */
  md5_10m: string;
}

/**
 * 申请上传（C2C）
 * POST /v2/users/{user_id}/upload_prepare
 * 
 * @param accessToken - 访问令牌
 * @param userId - 用户 openid
 * @param fileType - 业务类型（1=图片, 2=视频, 3=语音, 4=文件）
 * @param fileName - 文件名
 * @param fileSize - 文件大小（字节）
 * @param hashes - 文件哈希信息（md5, sha1, md5_10m）
 * @returns 上传任务 ID、分块大小、分片预签名链接列表
 */
export async function c2cUploadPrepare(
  accessToken: string,
  userId: string,
  fileType: MediaFileType,
  fileName: string,
  fileSize: number,
  hashes: UploadPrepareHashes,
): Promise<UploadPrepareResponse> {
  return apiRequest<UploadPrepareResponse>(
    accessToken, "POST", `/v2/users/${userId}/upload_prepare`,
    { file_type: fileType, file_name: fileName, file_size: fileSize, md5: hashes.md5, sha1: hashes.sha1, md5_10m: hashes.md5_10m },
  );
}

/**
 * 完成分片上传（C2C）
 * POST /v2/users/{user_id}/upload_part_finish
 * 
 * @param accessToken - 访问令牌
 * @param userId - 用户 openid
 * @param uploadId - 上传任务 ID
 * @param partIndex - 分片索引（从 1 开始）
 * @param blockSize - 分块大小（字节）
 * @param md5 - 分片数据的 MD5（十六进制）
 */
export async function c2cUploadPartFinish(
  accessToken: string,
  userId: string,
  uploadId: string,
  partIndex: number,
  blockSize: number,
  md5: string,
  retryTimeoutMs?: number,
): Promise<void> {
  await partFinishWithRetry(
    accessToken, "POST", `/v2/users/${userId}/upload_part_finish`,
    { upload_id: uploadId, part_index: partIndex, block_size: blockSize, md5 },
    retryTimeoutMs,
  );
}

/**
 * 完成文件上传（C2C）
 * POST /v2/users/{user_id}/files
 * 
 * @param accessToken - 访问令牌
 * @param userId - 用户 openid
 * @param uploadId - 上传任务 ID
 * @returns 文件信息（file_uuid, file_info, ttl）
 */
export async function c2cCompleteUpload(
  accessToken: string,
  userId: string,
  uploadId: string,
): Promise<MediaUploadResponse> {
  return completeUploadWithRetry(
    accessToken, "POST", `/v2/users/${userId}/files`,
    { upload_id: uploadId },
  );
}

/**
 * 申请上传（Group）
 * POST /v2/groups/{group_id}/upload_prepare
 */
export async function groupUploadPrepare(
  accessToken: string,
  groupId: string,
  fileType: MediaFileType,
  fileName: string,
  fileSize: number,
  hashes: UploadPrepareHashes,
): Promise<UploadPrepareResponse> {
  return apiRequest<UploadPrepareResponse>(
    accessToken, "POST", `/v2/groups/${groupId}/upload_prepare`,
    { file_type: fileType, file_name: fileName, file_size: fileSize, md5: hashes.md5, sha1: hashes.sha1, md5_10m: hashes.md5_10m },
  );
}

/**
 * 完成分片上传（Group）
 * POST /v2/groups/{group_id}/upload_part_finish
 */
export async function groupUploadPartFinish(
  accessToken: string,
  groupId: string,
  uploadId: string,
  partIndex: number,
  blockSize: number,
  md5: string,
  retryTimeoutMs?: number,
): Promise<void> {
  await partFinishWithRetry(
    accessToken, "POST", `/v2/groups/${groupId}/upload_part_finish`,
    { upload_id: uploadId, part_index: partIndex, block_size: blockSize, md5 },
    retryTimeoutMs,
  );
}

/**
 * 完成文件上传（Group）
 * POST /v2/groups/{group_id}/files
 */
export async function groupCompleteUpload(
  accessToken: string,
  groupId: string,
  uploadId: string,
): Promise<MediaUploadResponse> {
  return completeUploadWithRetry(
    accessToken, "POST", `/v2/groups/${groupId}/files`,
    { upload_id: uploadId },
  );
}

export async function uploadC2CMedia(
  accessToken: string,
  openid: string,
  fileType: MediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false,
  fileName?: string,
): Promise<UploadMediaResponse> {
  if (!url && !fileData) throw new Error("uploadC2CMedia: url or fileData is required");
  
  if (fileData) {
    const contentHash = computeFileHash(fileData);
    const cachedInfo = getCachedFileInfo(contentHash, "c2c", openid, fileType);
    if (cachedInfo) {
      return { file_uuid: "", file_info: cachedInfo, ttl: 0 };
    }
  }
  
  const body: Record<string, unknown> = { file_type: fileType, srv_send_msg: srvSendMsg };
  if (url) body.url = url;
  else if (fileData) body.file_data = fileData;
  if (fileType === MediaFileType.FILE && fileName) body.file_name = sanitizeFileName(fileName);
  
  const result = await apiRequestWithRetry<UploadMediaResponse>(
    accessToken, "POST", `/v2/users/${openid}/files`, body
  );
  
  if (fileData && result.file_info && result.ttl > 0) {
    const contentHash = computeFileHash(fileData);
    setCachedFileInfo(contentHash, "c2c", openid, fileType, result.file_info, result.file_uuid, result.ttl);
  }
  return result;
}

export async function uploadGroupMedia(
  accessToken: string,
  groupOpenid: string,
  fileType: MediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false,
  fileName?: string,
): Promise<UploadMediaResponse> {
  if (!url && !fileData) throw new Error("uploadGroupMedia: url or fileData is required");
  
  if (fileData) {
    const contentHash = computeFileHash(fileData);
    const cachedInfo = getCachedFileInfo(contentHash, "group", groupOpenid, fileType);
    if (cachedInfo) {
      return { file_uuid: "", file_info: cachedInfo, ttl: 0 };
    }
  }
  
  const body: Record<string, unknown> = { file_type: fileType, srv_send_msg: srvSendMsg };
  if (url) body.url = url;
  else if (fileData) body.file_data = fileData;
  if (fileType === MediaFileType.FILE && fileName) body.file_name = sanitizeFileName(fileName);
  
  const result = await apiRequestWithRetry<UploadMediaResponse>(
    accessToken, "POST", `/v2/groups/${groupOpenid}/files`, body
  );
  
  if (fileData && result.file_info && result.ttl > 0) {
    const contentHash = computeFileHash(fileData);
    setCachedFileInfo(contentHash, "group", groupOpenid, fileType, result.file_info, result.file_uuid, result.ttl);
  }
  return result;
}

export async function sendC2CMediaMessage(
  accessToken: string,
  openid: string,
  fileInfo: string,
  msgId?: string,
  content?: string,
  meta?: OutboundMeta,
): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return sendAndNotify(accessToken, "POST", `/v2/users/${openid}/messages`, {
    msg_type: 7,
    media: { file_info: fileInfo },
    msg_seq: msgSeq,
    ...(content ? { content } : {}),
    ...(msgId ? { msg_id: msgId } : {}),
  }, meta ?? { text: content });
}

export async function sendGroupMediaMessage(
  accessToken: string,
  groupOpenid: string,
  fileInfo: string,
  msgId?: string,
  content?: string
): Promise<{ id: string; timestamp: string }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, {
    msg_type: 7,
    media: { file_info: fileInfo },
    msg_seq: msgSeq,
    ...(content ? { content } : {}),
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

export async function sendC2CImageMessage(accessToken: string, openid: string, imageUrl: string, msgId?: string, content?: string, localPath?: string): Promise<MessageResponse> {
  let uploadResult: UploadMediaResponse;
  const isBase64 = imageUrl.startsWith("data:");
  if (isBase64) {
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) throw new Error("Invalid Base64 Data URL format");
    uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.IMAGE, undefined, matches[2], false);
  } else {
    uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.IMAGE, imageUrl, undefined, false);
  }
  const meta: OutboundMeta = {
    text: content,
    mediaType: "image",
    ...(!isBase64 ? { mediaUrl: imageUrl } : {}),
    ...(localPath ? { mediaLocalPath: localPath } : {}),
  };
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, content, meta);
}

export async function sendGroupImageMessage(accessToken: string, groupOpenid: string, imageUrl: string, msgId?: string, content?: string): Promise<{ id: string; timestamp: string }> {
  let uploadResult: UploadMediaResponse;
  const isBase64 = imageUrl.startsWith("data:");
  if (isBase64) {
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) throw new Error("Invalid Base64 Data URL format");
    uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.IMAGE, undefined, matches[2], false);
  } else {
    uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.IMAGE, imageUrl, undefined, false);
  }
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}

export async function sendC2CVoiceMessage(accessToken: string, openid: string, voiceBase64?: string, voiceUrl?: string, msgId?: string, ttsText?: string, filePath?: string): Promise<MessageResponse> {
  const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.VOICE, voiceUrl, voiceBase64, false);
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, undefined, { 
    mediaType: "voice", 
    ...(ttsText ? { ttsText } : {}),
    ...(filePath ? { mediaLocalPath: filePath } : {})
  });
}

export async function sendGroupVoiceMessage(accessToken: string, groupOpenid: string, voiceBase64?: string, voiceUrl?: string, msgId?: string): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.VOICE, voiceUrl, voiceBase64, false);
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}

export async function sendC2CFileMessage(accessToken: string, openid: string, fileBase64?: string, fileUrl?: string, msgId?: string, fileName?: string, localFilePath?: string): Promise<MessageResponse> {
  const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.FILE, fileUrl, fileBase64, false, fileName);
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, undefined,
    { mediaType: "file", mediaUrl: fileUrl, mediaLocalPath: localFilePath ?? fileName });
}

export async function sendGroupFileMessage(accessToken: string, groupOpenid: string, fileBase64?: string, fileUrl?: string, msgId?: string, fileName?: string): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.FILE, fileUrl, fileBase64, false, fileName);
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}

export async function sendC2CVideoMessage(accessToken: string, openid: string, videoUrl?: string, videoBase64?: string, msgId?: string, content?: string, localPath?: string): Promise<MessageResponse> {
  const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.VIDEO, videoUrl, videoBase64, false);
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, content,
    { text: content, mediaType: "video", ...(videoUrl ? { mediaUrl: videoUrl } : {}), ...(localPath ? { mediaLocalPath: localPath } : {}) });
}

export async function sendGroupVideoMessage(accessToken: string, groupOpenid: string, videoUrl?: string, videoBase64?: string, msgId?: string, content?: string): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.VIDEO, videoUrl, videoBase64, false);
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}

// ==========================================
// 后台 Token 刷新 (P1-1) - 按 appId 隔离
// ==========================================

interface BackgroundTokenRefreshOptions {
  refreshAheadMs?: number;
  randomOffsetMs?: number;
  minRefreshIntervalMs?: number;
  retryDelayMs?: number;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

const backgroundRefreshControllers = new Map<string, AbortController>();

export function startBackgroundTokenRefresh(
  appId: string,
  clientSecret: string,
  options?: BackgroundTokenRefreshOptions
): void {
  if (backgroundRefreshControllers.has(appId)) {
    console.log(`[qqbot-api:${appId}] Background token refresh already running`);
    return;
  }

  const {
    refreshAheadMs = 5 * 60 * 1000, 
    randomOffsetMs = 30 * 1000, 
    minRefreshIntervalMs = 60 * 1000, 
    retryDelayMs = 5 * 1000, 
    log,
  } = options ?? {};

  const controller = new AbortController();
  backgroundRefreshControllers.set(appId, controller);
  const signal = controller.signal;

  const refreshLoop = async () => {
    log?.info?.(`[qqbot-api:${appId}] Background token refresh started`);

    while (!signal.aborted) {
      try {
        await getAccessToken(appId, clientSecret);
        const cached = tokenCacheMap.get(appId);

        if (cached) {
          const expiresIn = cached.expiresAt - Date.now();
          const randomOffset = Math.random() * randomOffsetMs;
          const refreshIn = Math.max(
            expiresIn - refreshAheadMs - randomOffset,
            minRefreshIntervalMs
          );

          log?.debug?.(`[qqbot-api:${appId}] Token valid, next refresh in ${Math.round(refreshIn / 1000)}s`);
          await sleep(refreshIn, signal);
        } else {
          log?.debug?.(`[qqbot-api:${appId}] No cached token, retrying soon`);
          await sleep(minRefreshIntervalMs, signal);
        }
      } catch (err) {
        if (signal.aborted) break;
        log?.error?.(`[qqbot-api:${appId}] Background token refresh failed: ${err}`);
        await sleep(retryDelayMs, signal);
      }
    }

    backgroundRefreshControllers.delete(appId);
    log?.info?.(`[qqbot-api:${appId}] Background token refresh stopped`);
  };

  refreshLoop().catch((err) => {
    backgroundRefreshControllers.delete(appId);
    log?.error?.(`[qqbot-api:${appId}] Background token refresh crashed: ${err}`);
  });
}

/**
 * 停止后台 Token 刷新
 * @param appId 选填。如果有，仅停止该账号的定时刷新。
 */
export function stopBackgroundTokenRefresh(appId?: string): void {
  if (appId) {
    const controller = backgroundRefreshControllers.get(appId);
    if (controller) {
      controller.abort();
      backgroundRefreshControllers.delete(appId);
    }
  } else {
    for (const controller of backgroundRefreshControllers.values()) {
      controller.abort();
    }
    backgroundRefreshControllers.clear();
  }
}

export function isBackgroundTokenRefreshRunning(appId?: string): boolean {
  if (appId) return backgroundRefreshControllers.has(appId);
  return backgroundRefreshControllers.size > 0;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("Aborted"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ============ 流式消息 API ============

import type { StreamMessageRequest, StreamMessageResponse } from "./types.js";

/**
 * 发送流式消息（C2C 私聊）
 * 
 * 流式协议：
 * - 首次调用时不传 stream_msg_id，由平台返回
 * - 后续分片携带 stream_msg_id 和递增 msg_seq
 * - input_state="1" 表示生成中，"10" 表示生成结束（终结状态）
 * 
 * @param accessToken - access_token
 * @param openid - 用户 openid
 * @param req - 流式消息请求体
 * @returns 流式消息响应
 */
export async function sendC2CStreamMessage(
  accessToken: string,
  openid: string,
  req: StreamMessageRequest,
): Promise<StreamMessageResponse> {
  const path = `/v2/users/${openid}/stream_messages`;
  const body: Record<string, unknown> = {
    input_mode: req.input_mode,
    input_state: req.input_state,
    content_type: req.content_type,
    content_raw: req.content_raw,
    event_id: req.event_id,
    msg_id: req.msg_id,
    msg_seq: req.msg_seq,
    index: req.index,
  };
  if (req.stream_msg_id) {
    body.stream_msg_id = req.stream_msg_id;
  }
  return apiRequest<StreamMessageResponse>(accessToken, "POST", path, body);
}
