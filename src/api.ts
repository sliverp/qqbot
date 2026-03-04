/**
 * QQ Bot API 鉴权和请求封装
 */

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
let cachedTokens: Map<string, { token: string; expiresAt: number }> = new Map();
let tokenFetchPromises: Map<string, Promise<string>> = new Map();

/**
 * 获取 AccessToken（带缓存 + singleflight 并发安全）
 * 
 * 使用 singleflight 模式：当多个请求同时发现 Token 过期时，
 * 只有第一个请求会真正去获取新 Token，其他请求复用同一个 Promise。
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  const cacheKey = appId;
  const cached = cachedTokens.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.token;
  }

  const existingPromise = tokenFetchPromises.get(cacheKey);
  if (existingPromise) {
    console.log(`[qqbot-api] Token fetch in progress for ${appId}, waiting for existing request...`);
    return existingPromise;
  }

  const promise = (async () => {
    try {
      return await doFetchToken(appId, clientSecret);
    } finally {
      tokenFetchPromises.delete(cacheKey);
    }
  })();

  tokenFetchPromises.set(cacheKey, promise);
  return promise;
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

  const tokenData = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  };
  cachedTokens.set(appId, tokenData);

  console.log(`[qqbot-api] Token cached for ${appId}, expires at: ${new Date(tokenData.expiresAt).toISOString()}`);
  return tokenData.token;
}

/**
 * 清除 Token 缓存
 */
export function clearTokenCache(appId?: string): void {
  if (appId) {
    cachedTokens.delete(appId);
  } else {
    cachedTokens.clear();
  }
}

/**
 * 获取 Token 缓存状态（用于监控）
 */
export function getTokenStatus(appId?: string): { status: "valid" | "expired" | "refreshing" | "none"; expiresAt: number | null } {
  if (appId) {
    const promise = tokenFetchPromises.get(appId);
    if (promise) {
      const cached = cachedTokens.get(appId);
      return { status: "refreshing", expiresAt: cached?.expiresAt ?? null };
    }
    const cached = cachedTokens.get(appId);
    if (!cached) {
      return { status: "none", expiresAt: null };
    }
    const isValid = Date.now() < cached.expiresAt - 5 * 60 * 1000;
    return { status: isValid ? "valid" : "expired", expiresAt: cached.expiresAt };
  }
  if (tokenFetchPromises.size > 0) {
    return { status: "refreshing", expiresAt: null };
  }
  if (cachedTokens.size === 0) {
    return { status: "none", expiresAt: null };
  }
  return { status: "valid", expiresAt: null };
}

/**
 * msg_seq 追踪器 - 用于对同一条消息的多次回复
 * key: msg_id, value: 当前 seq 值
 * 使用时间戳作为基础值，确保进程重启后不会重复
 */
const msgSeqTracker = new Map<string, number>();
const seqBaseTime = Math.floor(Date.now() / 1000) % 100000000; // 取秒级时间戳的后8位作为基础

/**
 * 获取并递增消息序号
 * 返回的 seq 会基于时间戳，避免进程重启后重复
 */
export function getNextMsgSeq(msgId: string): number {
  const current = msgSeqTracker.get(msgId) ?? 0;
  const next = current + 1;
  msgSeqTracker.set(msgId, next);
  
  // 清理过期的序号
  // 简单策略：保留最近 1000 条
  if (msgSeqTracker.size > 1000) {
    const keys = Array.from(msgSeqTracker.keys());
    for (let i = 0; i < 500; i++) {
      msgSeqTracker.delete(keys[i]);
    }
  }
  
  // 结合时间戳基础值，确保唯一性
  return seqBaseTime + next;
}

// API 请求超时配置（毫秒）
const DEFAULT_API_TIMEOUT = 30000; // 默认 30 秒
const FILE_UPLOAD_TIMEOUT = 120000; // 文件上传 120 秒（2 分钟）

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
    console.log(`[qqbot-api] >>> Body:`, JSON.stringify(body, null, 2));
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
 * @param url - 公网可访问的图片 URL（与 fileData 二选一）
 * @param fileData - Base64 编码的文件内容（与 url 二选一）
 */
export async function uploadC2CMedia(
  accessToken: string,
  openid: string,
  fileType: MediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false
): Promise<UploadMediaResponse> {
  if (!url && !fileData) {
    throw new Error("uploadC2CMedia: url or fileData is required");
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
  
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/files`, body);
}

/**
 * 上传富媒体文件到群聊
 * @param url - 公网可访问的图片 URL（与 fileData 二选一）
 * @param fileData - Base64 编码的文件内容（与 url 二选一）
 */
export async function uploadGroupMedia(
  accessToken: string,
  groupOpenid: string,
  fileType: MediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false
): Promise<UploadMediaResponse> {
  if (!url && !fileData) {
    throw new Error("uploadGroupMedia: url or fileData is required");
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
  
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/files`, body);
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

const backgroundRefreshControllers: Map<string, AbortController> = new Map();

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
  const key = `refresh-${appId}`;
  if (backgroundRefreshControllers.has(key)) {
    console.log(`[qqbot-api] Background token refresh already running for ${appId}`);
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
  backgroundRefreshControllers.set(key, controller);
  const signal = controller.signal;

  const refreshLoop = async () => {
    log?.info?.(`[qqbot-api] Background token refresh started for ${appId}`);

    while (!signal.aborted) {
      try {
        await getAccessToken(appId, clientSecret);

        const cached = cachedTokens.get(appId);
        if (cached) {
          const expiresIn = cached.expiresAt - Date.now();
          const randomOffset = Math.random() * randomOffsetMs;
          const refreshIn = Math.max(
            expiresIn - refreshAheadMs - randomOffset,
            minRefreshIntervalMs
          );

          log?.debug?.(
            `[qqbot-api] Token valid for ${appId}, next refresh in ${Math.round(refreshIn / 1000)}s`
          );

          await sleep(refreshIn, signal);
        } else {
          log?.debug?.(`[qqbot-api] No cached token for ${appId}, retrying soon`);
          await sleep(minRefreshIntervalMs, signal);
        }
      } catch (err) {
        if (signal.aborted) break;
        
        log?.error?.(`[qqbot-api] Background token refresh failed for ${appId}: ${err}`);
        await sleep(retryDelayMs, signal);
      }
    }

    backgroundRefreshControllers.delete(key);
    log?.info?.(`[qqbot-api] Background token refresh stopped for ${appId}`);
  };

  refreshLoop().catch((err) => {
    backgroundRefreshControllers.delete(key);
    log?.error?.(`[qqbot-api] Background token refresh crashed for ${appId}: ${err}`);
  });
}

/**
 * 停止后台 Token 刷新
 */
export function stopBackgroundTokenRefresh(appId?: string): void {
  if (appId) {
    const key = `refresh-${appId}`;
    const controller = backgroundRefreshControllers.get(key);
    if (controller) {
      controller.abort();
      backgroundRefreshControllers.delete(key);
    }
  } else {
    for (const controller of backgroundRefreshControllers.values()) {
      controller.abort();
    }
    backgroundRefreshControllers.clear();
  }
}

/**
 * 检查后台 Token 刷新是否正在运行
 */
export function isBackgroundTokenRefreshRunning(appId?: string): boolean {
  if (appId) {
    return backgroundRefreshControllers.has(`refresh-${appId}`);
  }
  return backgroundRefreshControllers.size > 0;
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