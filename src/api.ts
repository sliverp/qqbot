/**
 * QQ Bot API 鉴权和请求封装
 */

import { computeFileHash, getCachedFileInfo, setCachedFileInfo } from "./utils/upload-cache.js";
import { sanitizeFileName } from "./utils/platform.js";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

// 运行时配置
let currentMarkdownSupport = false;

/**
 * 初始化 API 配置
 * @param options.markdownSupport - 是否支持 markdown 消息（默认 false，需要机器人具备该权限才能启用）
 */
export function initApiConfig(options: { markdownSupport?: boolean }): void {
  currentMarkdownSupport = options.markdownSupport === true; // 默认为 false，需要机器人具备 markdown 消息权限才能启用
}

/**
 * 获取当前是否支持 markdown
 */
export function isMarkdownSupport(): boolean {
  return currentMarkdownSupport;
}

let cachedToken: { token: string; expiresAt: number; appId: string } | null = null;
// Singleflight: 防止并发获取 Token 的 Promise 缓存
let tokenFetchPromise: Promise<string> | null = null;

/**
 * 获取 AccessToken（带缓存 + singleflight 并发安全）
 * 
 * 使用 singleflight 模式：当多个请求同时发现 Token 过期时，
 * 只有第一个请求会真正去获取新 Token，其他请求复用同一个 Promise。
 * 
 * 当 appId 发生变化时，自动使旧缓存失效并获取新 Token。
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  // 检查缓存：未过期 且 appId 未变化 时复用
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000 && cachedToken.appId === appId) {
    return cachedToken.token;
  }

  // appId 变化时，主动清除旧缓存
  if (cachedToken && cachedToken.appId !== appId) {
    console.log(`[qqbot-api] appId changed (${cachedToken.appId} → ${appId}), clearing token cache`);
    cachedToken = null;
    tokenFetchPromise = null; // 旧 appId 的 inflight 请求也作废
  }

  // Singleflight: 如果已有进行中的 Token 获取请求，复用它
  if (tokenFetchPromise) {
    console.log(`[qqbot-api] Token fetch in progress, waiting for existing request...`);
    return tokenFetchPromise;
  }

  // 创建新的 Token 获取 Promise（singleflight 入口）
  tokenFetchPromise = (async () => {
    try {
      return await doFetchToken(appId, clientSecret);
    } finally {
      // 无论成功失败，都清除 Promise 缓存
      tokenFetchPromise = null;
    }
  })();

  return tokenFetchPromise;
}

/**
 * 实际执行 Token 获取的内部函数
 */
async function doFetchToken(appId: string, clientSecret: string): Promise<string> {

  const requestBody = { appId, clientSecret };
  const requestHeaders = { "Content-Type": "application/json" };
  
  // 打印请求信息（隐藏敏感信息）
  console.log(`[qqbot-api] >>> POST ${TOKEN_URL}`);
  console.log(`[qqbot-api] >>> Headers:`, JSON.stringify(requestHeaders, null, 2));
  console.log(`[qqbot-api] >>> Body:`, JSON.stringify({ appId, clientSecret: "***" }, null, 2));

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    console.error(`[qqbot-api] <<< Network error:`, err);
    throw new Error(`Network error getting access_token: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 打印响应头
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  console.log(`[qqbot-api] <<< Status: ${response.status} ${response.statusText}`);
  console.log(`[qqbot-api] <<< Headers:`, JSON.stringify(responseHeaders, null, 2));

  let data: { access_token?: string; expires_in?: number };
  let rawBody: string;
  try {
    rawBody = await response.text();
    // 隐藏 token 值
    const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"');
    console.log(`[qqbot-api] <<< Body:`, logBody);
    data = JSON.parse(rawBody) as { access_token?: string; expires_in?: number };
  } catch (err) {
    console.error(`[qqbot-api] <<< Parse error:`, err);
    throw new Error(`Failed to parse access_token response: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!data.access_token) {
    throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    appId,
  };

  console.log(`[qqbot-api] Token cached for appId=${appId}, expires at: ${new Date(cachedToken.expiresAt).toISOString()}`);
  return cachedToken.token;
}

/**
 * 清除 Token 缓存
 */
export function clearTokenCache(): void {
  cachedToken = null;
  // 注意：不清除 tokenFetchPromise，让进行中的请求完成
  // 下次调用 getAccessToken 时会自动获取新 Token
}

/**
 * 获取 Token 缓存状态（用于监控）
 */
export function getTokenStatus(): { status: "valid" | "expired" | "refreshing" | "none"; expiresAt: number | null } {
  if (tokenFetchPromise) {
    return { status: "refreshing", expiresAt: cachedToken?.expiresAt ?? null };
  }
  if (!cachedToken) {
    return { status: "none", expiresAt: null };
  }
  const isValid = Date.now() < cachedToken.expiresAt - 5 * 60 * 1000;
  return { status: isValid ? "valid" : "expired", expiresAt: cachedToken.expiresAt };
}

/**
 * 获取全局唯一的消息序号（范围 0 ~ 65535）
 * 使用毫秒级时间戳低位 + 随机数异或混合，无状态，避免碰撞
 * @param _msgId - 保留参数，不再用于分桶计数
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
 * @param accessToken 访问令牌
 * @param method 请求方法
 * @param path 请求路径
 * @param body 请求体
 * @param timeoutMs 超时时间（毫秒），不传则根据请求类型自动选择
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
  };
  
  // 根据请求类型自动选择超时时间
  // 文件上传接口 (/files) 使用更长的超时时间
  const isFileUpload = path.includes("/files");
  const timeout = timeoutMs ?? (isFileUpload ? FILE_UPLOAD_TIMEOUT : DEFAULT_API_TIMEOUT);
  
  // 创建 AbortController 用于超时控制
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
  console.log(`[qqbot-api] >>> Headers:`, JSON.stringify(headers, null, 2));
  if (body) {
    // 过滤 file_data 等大二进制字段，避免刷屏
    const logBody = { ...body } as Record<string, unknown>;
    if (typeof logBody.file_data === "string") {
      logBody.file_data = `<base64 ${(logBody.file_data as string).length} chars>`;
    }
    console.log(`[qqbot-api] >>> Body:`, JSON.stringify(logBody, null, 2));
  }

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      console.error(`[qqbot-api] <<< Request timeout after ${timeout}ms`);
      throw new Error(`Request timeout [${path}]: exceeded ${timeout}ms`);
    }
    console.error(`[qqbot-api] <<< Network error:`, err);
    throw new Error(`Network error [${path}]: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

  // 打印响应头
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  console.log(`[qqbot-api] <<< Status: ${res.status} ${res.statusText}`);
  console.log(`[qqbot-api] <<< Headers:`, JSON.stringify(responseHeaders, null, 2));

  let data: T;
  let rawBody: string;
  try {
    rawBody = await res.text();
    console.log(`[qqbot-api] <<< Body:`, rawBody);
    data = JSON.parse(rawBody) as T;
  } catch (err) {
    console.error(`[qqbot-api] <<< Parse error:`, err);
    throw new Error(`Failed to parse response [${path}]: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const error = data as { message?: string; code?: number };
    throw new Error(`API Error [${path}]: ${error.message ?? JSON.stringify(data)}`);
  }

  return data;
}

// ============ 上传重试（指数退避） ============

/** 上传重试配置 */
const UPLOAD_MAX_RETRIES = 2;
const UPLOAD_BASE_DELAY_MS = 1000; // 首次重试等待 1 秒

/**
 * 带指数退避重试的 API 请求
 * 仅用于上传类请求（/files），普通请求不重试
 */
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
      
      // 不对以下错误重试，直接快速失败：
      // - 参数错误(400)、鉴权错误(401)、格式错误
      // - 服务端返回"上传超时"（QQ 平台侧拉取资源超时，重试也没用）
      // - 本地请求超时（已等够 120s）
      const errMsg = lastError.message;
      if (
        errMsg.includes("400") || errMsg.includes("401") || errMsg.includes("Invalid") ||
        errMsg.includes("上传超时") || errMsg.includes("timeout") || errMsg.includes("Timeout")
      ) {
        throw lastError;
      }

      if (attempt < maxRetries) {
        const delay = UPLOAD_BASE_DELAY_MS * Math.pow(2, attempt); // 1s, 2s
        console.log(`[qqbot-api] Upload attempt ${attempt + 1} failed, retrying in ${delay}ms: ${errMsg.slice(0, 100)}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

/**
 * 获取 WebSocket Gateway URL
 */
export async function getGatewayUrl(accessToken: string): Promise<string> {
  const data = await apiRequest<{ url: string }>(accessToken, "GET", "/gateway");
  return data.url;
}

// ============ 消息发送接口 ============

/**
 * 消息响应
 */
export interface MessageResponse {
  id: string;
  timestamp: number | string;
}

/**
 * 构建消息体
 * 根据 markdownSupport 配置决定消息格式：
 * - markdown 模式: { markdown: { content }, msg_type: 2 }
 * - 纯文本模式: { content, msg_type: 0 }
 */
function buildMessageBody(
  content: string,
  msgId: string | undefined,
  msgSeq: number
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

  return body;
}

/**
 * 发送 C2C 单聊消息
 */
export async function sendC2CMessage(
  accessToken: string,
  openid: string,
  content: string,
  msgId?: string
): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = buildMessageBody(content, msgId, msgSeq);
  
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body);
}

/**
 * 发送 C2C 输入状态提示（告知用户机器人正在输入）
 */
export async function sendC2CInputNotify(
  accessToken: string,
  openid: string,
  msgId?: string,
  inputSecond: number = 60
): Promise<void> {
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
  
  await apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body);
}

/**
 * 发送频道消息（不支持流式）
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
): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = buildMessageBody(content, msgId, msgSeq);
  
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body);
}

/**
 * 构建主动消息请求体
 * 根据 markdownSupport 配置决定消息格式：
 * - markdown 模式: { markdown: { content }, msg_type: 2 }
 * - 纯文本模式: { content, msg_type: 0 }
 * 
 * 注意：主动消息不支持流式发送
 */
function buildProactiveMessageBody(content: string): Record<string, unknown> {
  // 主动消息内容校验（参考 Telegram 机制）
  if (!content || content.trim().length === 0) {
    throw new Error("主动消息内容不能为空 (markdown.content is empty)");
  }

  if (currentMarkdownSupport) {
    return {
      markdown: { content },
      msg_type: 2,
    };
  } else {
    return {
      content,
      msg_type: 0,
    };
  }
}

/**
 * 主动发送 C2C 单聊消息（不需要 msg_id，每月限 4 条/用户）
 * 
 * 注意：
 * 1. 内容不能为空（对应 markdown.content 字段）
 * 2. 不支持流式发送
 */
export async function sendProactiveC2CMessage(
  accessToken: string,
  openid: string,
  content: string
): Promise<{ id: string; timestamp: number }> {
  const body = buildProactiveMessageBody(content);
  console.log(`[qqbot-api] sendProactiveC2CMessage: openid=${openid}, msg_type=${body.msg_type}, content_len=${content.length}`);
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body);
}

/**
 * 主动发送群聊消息（不需要 msg_id，每月限 4 条/群）
 * 
 * 注意：
 * 1. 内容不能为空（对应 markdown.content 字段）
 * 2. 不支持流式发送
 */
export async function sendProactiveGroupMessage(
  accessToken: string,
  groupOpenid: string,
  content: string
): Promise<{ id: string; timestamp: string }> {
  const body = buildProactiveMessageBody(content);
  console.log(`[qqbot-api] sendProactiveGroupMessage: group=${groupOpenid}, msg_type=${body.msg_type}, content_len=${content.length}`);
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body);
}

// ============ 富媒体消息支持 ============

/**
 * 媒体文件类型
 */
export enum MediaFileType {
  IMAGE = 1,
  VIDEO = 2,
  VOICE = 3,
  FILE = 4, // 暂未开放
}

/**
 * 上传富媒体文件的响应
 */
export interface UploadMediaResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
  id?: string; // 仅当 srv_send_msg=true 时返回
}

/**
 * 上传富媒体文件到 C2C 单聊
 * 
 * 改进：
 * 1. file_info 缓存 — 相同文件不重复上传（借鉴 Telegram file_id）
 * 2. 指数退避重试 — 网络波动时自动重试最多 2 次
 * 
 * @param url - 公网可访问的图片 URL（与 fileData 二选一）
 * @param fileData - Base64 编码的文件内容（与 url 二选一）
 * @param fileName - 文件名（file_type=FILE 时必传，例如 "readme.md"）
 */
export async function uploadC2CMedia(
  accessToken: string,
  openid: string,
  fileType: MediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false,
  fileName?: string,
): Promise<UploadMediaResponse> {
  if (!url && !fileData) {
    throw new Error("uploadC2CMedia: url or fileData is required");
  }
  
  // 缓存查询：如果有 fileData，用内容 hash 查缓存
  if (fileData) {
    const contentHash = computeFileHash(fileData);
    const cachedInfo = getCachedFileInfo(contentHash, "c2c", openid, fileType);
    if (cachedInfo) {
      console.log(`[qqbot-api] uploadC2CMedia: using cached file_info (skip upload)`);
      return { file_uuid: "", file_info: cachedInfo, ttl: 0 };
    }
  }
  
  const body: Record<string, unknown> = {
    file_type: fileType,
    srv_send_msg: srvSendMsg,
  };
  
  if (url) {
    body.url = url;
  } else if (fileData) {
    body.file_data = fileData;
  }

  if (fileType === MediaFileType.FILE && fileName) {
    body.file_name = sanitizeFileName(fileName);
  }
  
  // 使用带重试的请求
  const result = await apiRequestWithRetry<UploadMediaResponse>(
    accessToken, "POST", `/v2/users/${openid}/files`, body
  );
  
  // 写入缓存
  if (fileData && result.file_info && result.ttl > 0) {
    const contentHash = computeFileHash(fileData);
    setCachedFileInfo(contentHash, "c2c", openid, fileType, result.file_info, result.file_uuid, result.ttl);
  }
  
  return result;
}

/**
 * 上传富媒体文件到群聊
 * 
 * 改进：同 uploadC2CMedia
 * 
 * @param url - 公网可访问的图片 URL（与 fileData 二选一）
 * @param fileData - Base64 编码的文件内容（与 url 二选一）
 * @param fileName - 文件名（file_type=FILE 时必传，例如 "readme.md"）
 */
export async function uploadGroupMedia(
  accessToken: string,
  groupOpenid: string,
  fileType: MediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false,
  fileName?: string,
): Promise<UploadMediaResponse> {
  if (!url && !fileData) {
    throw new Error("uploadGroupMedia: url or fileData is required");
  }
  
  // 缓存查询
  if (fileData) {
    const contentHash = computeFileHash(fileData);
    const cachedInfo = getCachedFileInfo(contentHash, "group", groupOpenid, fileType);
    if (cachedInfo) {
      console.log(`[qqbot-api] uploadGroupMedia: using cached file_info (skip upload)`);
      return { file_uuid: "", file_info: cachedInfo, ttl: 0 };
    }
  }
  
  const body: Record<string, unknown> = {
    file_type: fileType,
    srv_send_msg: srvSendMsg,
  };
  
  if (url) {
    body.url = url;
  } else if (fileData) {
    body.file_data = fileData;
  }

  if (fileType === MediaFileType.FILE && fileName) {
    body.file_name = sanitizeFileName(fileName);
  }
  
  // 使用带重试的请求
  const result = await apiRequestWithRetry<UploadMediaResponse>(
    accessToken, "POST", `/v2/groups/${groupOpenid}/files`, body
  );
  
  // 写入缓存
  if (fileData && result.file_info && result.ttl > 0) {
    const contentHash = computeFileHash(fileData);
    setCachedFileInfo(contentHash, "group", groupOpenid, fileType, result.file_info, result.file_uuid, result.ttl);
  }
  
  return result;
}

/**
 * 发送 C2C 单聊富媒体消息
 */
export async function sendC2CMediaMessage(
  accessToken: string,
  openid: string,
  fileInfo: string,
  msgId?: string,
  content?: string
): Promise<{ id: string; timestamp: number }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, {
    msg_type: 7, // 富媒体消息类型
    media: { file_info: fileInfo },
    msg_seq: msgSeq,
    ...(content ? { content } : {}),
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

/**
 * 发送群聊富媒体消息
 */
export async function sendGroupMediaMessage(
  accessToken: string,
  groupOpenid: string,
  fileInfo: string,
  msgId?: string,
  content?: string
): Promise<{ id: string; timestamp: string }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, {
    msg_type: 7, // 富媒体消息类型
    media: { file_info: fileInfo },
    msg_seq: msgSeq,
    ...(content ? { content } : {}),
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

/**
 * 发送带图片的 C2C 单聊消息（封装上传+发送）
 * @param imageUrl - 图片来源，支持：
 *   - 公网 URL: https://example.com/image.png
 *   - Base64 Data URL: data:image/png;base64,xxxxx
 */
export async function sendC2CImageMessage(
  accessToken: string,
  openid: string,
  imageUrl: string,
  msgId?: string,
  content?: string
): Promise<{ id: string; timestamp: number }> {
  let uploadResult: UploadMediaResponse;
  
  // 检查是否是 Base64 Data URL
  if (imageUrl.startsWith("data:")) {
    // 解析 Base64 Data URL: data:image/png;base64,xxxxx
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Invalid Base64 Data URL format");
    }
    const base64Data = matches[2];
    // 使用 file_data 上传
    uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.IMAGE, undefined, base64Data, false);
  } else {
    // 公网 URL，使用 url 参数上传
    uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.IMAGE, imageUrl, undefined, false);
  }
  
  // 发送富媒体消息
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, content);
}

/**
 * 发送带图片的群聊消息（封装上传+发送）
 * @param imageUrl - 图片来源，支持：
 *   - 公网 URL: https://example.com/image.png
 *   - Base64 Data URL: data:image/png;base64,xxxxx
 */
export async function sendGroupImageMessage(
  accessToken: string,
  groupOpenid: string,
  imageUrl: string,
  msgId?: string,
  content?: string
): Promise<{ id: string; timestamp: string }> {
  let uploadResult: UploadMediaResponse;
  
  // 检查是否是 Base64 Data URL
  if (imageUrl.startsWith("data:")) {
    // 解析 Base64 Data URL: data:image/png;base64,xxxxx
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Invalid Base64 Data URL format");
    }
    const base64Data = matches[2];
    // 使用 file_data 上传
    uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.IMAGE, undefined, base64Data, false);
  } else {
    // 公网 URL，使用 url 参数上传
    uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.IMAGE, imageUrl, undefined, false);
  }
  
  // 发送富媒体消息
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}

/**
 * 发送 C2C 单聊语音消息（封装上传+发送）
 * @param voiceBase64 - SILK 格式语音的 Base64 编码
 */
export async function sendC2CVoiceMessage(
  accessToken: string,
  openid: string,
  voiceBase64: string,
  msgId?: string,
): Promise<{ id: string; timestamp: number }> {
  const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.VOICE, undefined, voiceBase64, false);
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId);
}

/**
 * 发送群聊语音消息（封装上传+发送）
 * @param voiceBase64 - SILK 格式语音的 Base64 编码
 */
export async function sendGroupVoiceMessage(
  accessToken: string,
  groupOpenid: string,
  voiceBase64: string,
  msgId?: string,
): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.VOICE, undefined, voiceBase64, false);
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}

/**
 * 发送 C2C 单聊文件消息（封装上传+发送）
 * @param fileBase64 - Base64 编码的文件内容
 * @param fileUrl - 公网可访问的文件 URL（与 fileBase64 二选一）
 * @param fileName - 文件名（例如 "readme.md"），从本地路径自动提取
 */
export async function sendC2CFileMessage(
  accessToken: string,
  openid: string,
  fileBase64?: string,
  fileUrl?: string,
  msgId?: string,
  fileName?: string,
): Promise<{ id: string; timestamp: number }> {
  const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.FILE, fileUrl, fileBase64, false, fileName);
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId);
}

/**
 * 发送群聊文件消息（封装上传+发送）
 * @param fileBase64 - Base64 编码的文件内容
 * @param fileUrl - 公网可访问的文件 URL（与 fileBase64 二选一）
 * @param fileName - 文件名（例如 "readme.md"），从本地路径自动提取
 */
export async function sendGroupFileMessage(
  accessToken: string,
  groupOpenid: string,
  fileBase64?: string,
  fileUrl?: string,
  msgId?: string,
  fileName?: string,
): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.FILE, fileUrl, fileBase64, false, fileName);
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}

/**
 * 发送 C2C 单聊视频消息（封装上传+发送）
 * @param videoUrl - 公网可访问的视频 URL（与 videoBase64 二选一）
 * @param videoBase64 - Base64 编码的视频内容（与 videoUrl 二选一）
 */
export async function sendC2CVideoMessage(
  accessToken: string,
  openid: string,
  videoUrl?: string,
  videoBase64?: string,
  msgId?: string,
  content?: string
): Promise<{ id: string; timestamp: number }> {
  const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.VIDEO, videoUrl, videoBase64, false);
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, content);
}

/**
 * 发送群聊视频消息（封装上传+发送）
 * @param videoUrl - 公网可访问的视频 URL（与 videoBase64 二选一）
 * @param videoBase64 - Base64 编码的视频内容（与 videoUrl 二选一）
 */
export async function sendGroupVideoMessage(
  accessToken: string,
  groupOpenid: string,
  videoUrl?: string,
  videoBase64?: string,
  msgId?: string,
  content?: string
): Promise<{ id: string; timestamp: string }> {
  const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.VIDEO, videoUrl, videoBase64, false);
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}

// ============ 后台 Token 刷新 (P1-1) ============

/**
 * 后台 Token 刷新配置
 */
interface BackgroundTokenRefreshOptions {
  /** 提前刷新时间（毫秒，默认 5 分钟） */
  refreshAheadMs?: number;
  /** 随机偏移范围（毫秒，默认 0-30 秒） */
  randomOffsetMs?: number;
  /** 最小刷新间隔（毫秒，默认 1 分钟） */
  minRefreshIntervalMs?: number;
  /** 失败后重试间隔（毫秒，默认 5 秒） */
  retryDelayMs?: number;
  /** 日志函数 */
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

// 后台刷新状态
let backgroundRefreshRunning = false;
let backgroundRefreshAbortController: AbortController | null = null;

/**
 * 启动后台 Token 刷新
 * 在后台定时刷新 Token，避免请求时才发现过期
 * 
 * @param appId 应用 ID
 * @param clientSecret 应用密钥
 * @param options 配置选项
 */
export function startBackgroundTokenRefresh(
  appId: string,
  clientSecret: string,
  options?: BackgroundTokenRefreshOptions
): void {
  if (backgroundRefreshRunning) {
    console.log("[qqbot-api] Background token refresh already running");
    return;
  }

  const {
    refreshAheadMs = 5 * 60 * 1000, // 提前 5 分钟刷新
    randomOffsetMs = 30 * 1000, // 0-30 秒随机偏移
    minRefreshIntervalMs = 60 * 1000, // 最少 1 分钟后刷新
    retryDelayMs = 5 * 1000, // 失败后 5 秒重试
    log,
  } = options ?? {};

  backgroundRefreshRunning = true;
  backgroundRefreshAbortController = new AbortController();
  const signal = backgroundRefreshAbortController.signal;

  const refreshLoop = async () => {
    log?.info?.("[qqbot-api] Background token refresh started");

    while (!signal.aborted) {
      try {
        // 先确保有一个有效 Token
        await getAccessToken(appId, clientSecret);

        // 计算下次刷新时间
        if (cachedToken) {
          const expiresIn = cachedToken.expiresAt - Date.now();
          // 提前刷新时间 + 随机偏移（避免集群同时刷新）
          const randomOffset = Math.random() * randomOffsetMs;
          const refreshIn = Math.max(
            expiresIn - refreshAheadMs - randomOffset,
            minRefreshIntervalMs
          );

          log?.debug?.(
            `[qqbot-api] Token valid, next refresh in ${Math.round(refreshIn / 1000)}s`
          );

          // 等待到刷新时间
          await sleep(refreshIn, signal);
        } else {
          // 没有缓存的 Token，等待一段时间后重试
          log?.debug?.("[qqbot-api] No cached token, retrying soon");
          await sleep(minRefreshIntervalMs, signal);
        }
      } catch (err) {
        if (signal.aborted) break;
        
        // 刷新失败，等待后重试
        log?.error?.(`[qqbot-api] Background token refresh failed: ${err}`);
        await sleep(retryDelayMs, signal);
      }
    }

    backgroundRefreshRunning = false;
    log?.info?.("[qqbot-api] Background token refresh stopped");
  };

  // 异步启动，不阻塞调用者
  refreshLoop().catch((err) => {
    backgroundRefreshRunning = false;
    log?.error?.(`[qqbot-api] Background token refresh crashed: ${err}`);
  });
}

/**
 * 停止后台 Token 刷新
 */
export function stopBackgroundTokenRefresh(): void {
  if (backgroundRefreshAbortController) {
    backgroundRefreshAbortController.abort();
    backgroundRefreshAbortController = null;
  }
  backgroundRefreshRunning = false;
}

/**
 * 检查后台 Token 刷新是否正在运行
 */
export function isBackgroundTokenRefreshRunning(): boolean {
  return backgroundRefreshRunning;
}

/**
 * 可中断的 sleep 函数
 */
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