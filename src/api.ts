/**
 * QQ Bot API 鉴权和请求封装
 */

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * 获取 AccessToken（带缓存）
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  // 检查缓存，提前 5 分钟刷新
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) {
    return cachedToken.token;
  }

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, clientSecret }),
    });
  } catch (err) {
    throw new Error(`Network error getting access_token: ${err instanceof Error ? err.message : String(err)}`);
  }

  let data: { access_token?: string; expires_in?: number };
  try {
    data = (await response.json()) as { access_token?: string; expires_in?: number };
  } catch (err) {
    throw new Error(`Failed to parse access_token response: ${err instanceof Error ? err.message : String(err)}`);
  }

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

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    throw new Error(`Network error [${path}]: ${err instanceof Error ? err.message : String(err)}`);
  }

  let data: T;
  try {
    data = (await res.json()) as T;
  } catch (err) {
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
 * @param accessToken 访问令牌
 * @param openid 用户 openid
 * @param fileType 文件类型
 * @param url 媒体资源 URL
 * @param srvSendMsg 是否直接发送（推荐 false，获取 file_info 后再发送）
 */
export async function uploadC2CMedia(
  accessToken: string,
  openid: string,
  fileType: MediaFileType,
  url: string,
  srvSendMsg = false
): Promise<UploadMediaResponse> {
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/files`, {
    file_type: fileType,
    url,
    srv_send_msg: srvSendMsg,
  });
}

/**
 * 上传富媒体文件到群聊
 * @param accessToken 访问令牌
 * @param groupOpenid 群 openid
 * @param fileType 文件类型
 * @param url 媒体资源 URL
 * @param srvSendMsg 是否直接发送（推荐 false，获取 file_info 后再发送）
 */
export async function uploadGroupMedia(
  accessToken: string,
  groupOpenid: string,
  fileType: MediaFileType,
  url: string,
  srvSendMsg = false
): Promise<UploadMediaResponse> {
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/files`, {
    file_type: fileType,
    url,
    srv_send_msg: srvSendMsg,
  });
}

/**
 * 发送 C2C 单聊富媒体消息
 * @param accessToken 访问令牌
 * @param openid 用户 openid
 * @param fileInfo 从 uploadC2CMedia 获取的 file_info
 * @param msgId 被动回复时需要的消息 ID
 * @param content 可选的文字内容
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
 * @param accessToken 访问令牌
 * @param groupOpenid 群 openid
 * @param fileInfo 从 uploadGroupMedia 获取的 file_info
 * @param msgId 被动回复时需要的消息 ID
 * @param content 可选的文字内容
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
 * @param accessToken 访问令牌
 * @param openid 用户 openid
 * @param imageUrl 图片 URL
 * @param msgId 被动回复时需要的消息 ID
 * @param content 可选的文字内容
 */
export async function sendC2CImageMessage(
  accessToken: string,
  openid: string,
  imageUrl: string,
  msgId?: string,
  content?: string
): Promise<{ id: string; timestamp: number }> {
  // 先上传图片获取 file_info
  const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.IMAGE, imageUrl, false);
  // 再发送富媒体消息
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, content);
}

/**
 * 发送带图片的群聊消息（封装上传+发送）
 * @param accessToken 访问令牌
 * @param groupOpenid 群 openid
 * @param imageUrl 图片 URL
 * @param msgId 被动回复时需要的消息 ID
 * @param content 可选的文字内容
 */
export async function sendGroupImageMessage(
  accessToken: string,
  groupOpenid: string,
  imageUrl: string,
  msgId?: string,
  content?: string
): Promise<{ id: string; timestamp: string }> {
  // 先上传图片获取 file_info
  const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.IMAGE, imageUrl, false);
  // 再发送富媒体消息
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}
