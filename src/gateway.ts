import WebSocket from "ws";
import path from "node:path";
import * as fs from "node:fs";
import type { ResolvedQQBotAccount, WSPayload, C2CMessageEvent, GuildMessageEvent, GroupMessageEvent } from "./types.js";
import { getAccessToken, getGatewayUrl, sendC2CMessage, sendChannelMessage, sendGroupMessage, clearTokenCache, sendC2CImageMessage, sendGroupImageMessage, sendC2CVoiceMessage, sendGroupVoiceMessage, sendC2CVideoMessage, sendGroupVideoMessage, sendC2CFileMessage, sendGroupFileMessage, initApiConfig, startBackgroundTokenRefresh, stopBackgroundTokenRefresh, sendC2CInputNotify, onMessageSent } from "./api.js";
import { loadSession, saveSession, clearSession, type SessionState } from "./session-store.js";
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { getQQBotRuntime } from "./runtime.js";
import { startImageServer, isImageServerRunning, downloadFile, type ImageServerConfig } from "./image-server.js";
import { getImageSize, formatQQBotMarkdownImage, hasQQBotImageSize, DEFAULT_IMAGE_SIZE } from "./utils/image-size.js";
import { parseQQBotPayload, encodePayloadForCron, isCronReminderPayload, isMediaPayload, type CronReminderPayload, type MediaPayload } from "./utils/payload.js";
import { convertSilkToWav, isVoiceAttachment, formatDuration, resolveTTSConfig, textToSilk, audioFileToSilkBase64, waitForFile, isAudioFile } from "./utils/audio-convert.js";
import { normalizeMediaTags } from "./utils/media-tags.js";
import { checkFileSize, readFileAsync, fileExistsAsync, isLargeFile, formatFileSize } from "./utils/file-utils.js";
import { getQQBotDataDir, isLocalPath as isLocalFilePath, looksLikeLocalPath, normalizePath, sanitizeFileName, runDiagnostics } from "./utils/platform.js";
import { setRefIndex, getRefIndex, formatRefEntryForAgent, flushRefIndex, type RefAttachmentSummary } from "./ref-index-store.js";

/**
 * 通用 OpenAI 兼容 STT（语音转文字）
 *
 * 为什么在插件侧做 STT 而不走框架管道？
 * 框架的 applyMediaUnderstanding 同时执行 runCapability("audio") 和 extractFileBlocks。
 * 后者会把 WAV 文件的 PCM 二进制当文本注入 Body（looksLikeUtf8Text 误判），导致 context 爆炸。
 * 在插件侧完成 STT 后不把 WAV 放入 MediaPaths，即可规避此框架 bug。
 *
 * 配置解析策略（与 TTS 统一的两级回退）：
 * 1. 优先 channels.qqbot.stt（插件专属配置）
 * 2. 回退 tools.media.audio.models[0]（框架级配置）
 * 3. 再从 models.providers.[provider] 继承 apiKey/baseUrl
 * 4. 支持任何 OpenAI 兼容的 STT 服务
 */
interface STTConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function resolveSTTConfig(cfg: Record<string, unknown>): STTConfig | null {
  const c = cfg as any;

  // 优先使用 channels.qqbot.stt（插件专属配置）
  const channelStt = c?.channels?.qqbot?.stt;
  if (channelStt && channelStt.enabled !== false) {
    const providerId: string = channelStt?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = channelStt?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = channelStt?.apiKey || providerCfg?.apiKey;
    const model: string = channelStt?.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  // 回退到 tools.media.audio.models[0]（框架级配置）
  const audioModelEntry = c?.tools?.media?.audio?.models?.[0];
  if (audioModelEntry) {
    const providerId: string = audioModelEntry?.provider || "openai";
    const providerCfg = c?.models?.providers?.[providerId];
    const baseUrl: string | undefined = audioModelEntry?.baseUrl || providerCfg?.baseUrl;
    const apiKey: string | undefined = audioModelEntry?.apiKey || providerCfg?.apiKey;
    const model: string = audioModelEntry?.model || "whisper-1";
    if (baseUrl && apiKey) {
      return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
    }
  }

  return null;
}

async function transcribeAudio(audioPath: string, cfg: Record<string, unknown>): Promise<string | null> {
  const sttCfg = resolveSTTConfig(cfg);
  if (!sttCfg) return null;

  const fileBuffer = fs.readFileSync(audioPath);
  const fileName = sanitizeFileName(path.basename(audioPath));
  const mime = fileName.endsWith(".wav") ? "audio/wav"
    : fileName.endsWith(".mp3") ? "audio/mpeg"
    : fileName.endsWith(".ogg") ? "audio/ogg"
    : "application/octet-stream";

  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mime }), fileName);
  form.append("model", sttCfg.model);

  const resp = await fetch(`${sttCfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${sttCfg.apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`STT failed (HTTP ${resp.status}): ${detail.slice(0, 300)}`);
  }

  const result = await resp.json() as { text?: string };
  return result.text?.trim() || null;
}

// QQ Bot intents - 按权限级别分组
const INTENTS = {
  // 基础权限（默认有）
  GUILDS: 1 << 0,                    // 频道相关
  GUILD_MEMBERS: 1 << 1,             // 频道成员
  PUBLIC_GUILD_MESSAGES: 1 << 30,    // 频道公开消息（公域）
  // 需要申请的权限
  DIRECT_MESSAGE: 1 << 12,           // 频道私信
  GROUP_AND_C2C: 1 << 25,            // 群聊和 C2C 私聊（需申请）
};

// 权限级别：从高到低依次尝试
const INTENT_LEVELS = [
  // Level 0: 完整权限（群聊 + 私信 + 频道）
  {
    name: "full",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C,
    description: "群聊+私信+频道",
  },
  // Level 1: 群聊 + 频道（无私信）
  {
    name: "group+channel",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C,
    description: "群聊+频道",
  },
  // Level 2: 仅频道（基础权限）
  {
    name: "channel-only",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GUILD_MEMBERS,
    description: "仅频道消息",
  },
];

// 重连配置
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]; // 递增延迟
const RATE_LIMIT_DELAY = 60000; // 遇到频率限制时等待 60 秒
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_QUICK_DISCONNECT_COUNT = 3; // 连续快速断开次数阈值
const QUICK_DISCONNECT_THRESHOLD = 5000; // 5秒内断开视为快速断开

// 图床服务器配置（可通过环境变量覆盖）
const IMAGE_SERVER_PORT = parseInt(process.env.QQBOT_IMAGE_SERVER_PORT || "18765", 10);
// 使用绝对路径，确保文件保存和读取使用同一目录
const IMAGE_SERVER_DIR = process.env.QQBOT_IMAGE_SERVER_DIR || getQQBotDataDir("images");

// 消息队列配置（异步处理，防止阻塞心跳）
const MESSAGE_QUEUE_SIZE = 1000; // 最大队列长度（全局总量）
const PER_USER_QUEUE_SIZE = 20; // 单用户最大排队数
const MAX_CONCURRENT_USERS = 10; // 最大同时处理的用户数

// ============ 消息回复限流器 ============
// 同一 message_id 1小时内最多回复 4 次，超过1小时需降级为主动消息
const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1小时

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();

/**
 * 检查是否可以回复该消息（限流检查）
 * @param messageId 消息ID
 * @returns { allowed: boolean, remaining: number } allowed=是否允许回复，remaining=剩余次数
 */
function checkMessageReplyLimit(messageId: string): { allowed: boolean; remaining: number } {
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
  
  if (!record) {
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }
  
  // 检查是否过期
  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    messageReplyTracker.delete(messageId);
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }
  
  // 检查是否超过限制
  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
}

/**
 * 记录一次消息回复
 * @param messageId 消息ID
 */
function recordMessageReply(messageId: string): void {
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
}

// ============ QQ 表情标签解析 ============

/**
 * 解析 QQ 表情标签，将 <faceType=1,faceId="13",ext="base64..."> 格式
 * 替换为 【表情: 中文名】 格式
 * ext 字段为 Base64 编码的 JSON，格式如 {"text":"呲牙"}
 */
function parseFaceTags(text: string): string {
  if (!text) return text;

  // 匹配 <faceType=...,faceId="...",ext="..."> 格式的表情标签
  return text.replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_match, ext: string) => {
    try {
      const decoded = Buffer.from(ext, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      const faceName = parsed.text || "未知表情";
      return `【表情: ${faceName}】`;
    } catch {
      return _match;
    }
  });
}

// ============ 媒体发送友好错误提示 ============

/**
 * 将媒体上传/发送错误转为对用户友好的提示文案
 */
function formatMediaErrorMessage(mediaType: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("上传超时") || msg.includes("timeout") || msg.includes("Timeout")) {
    return `抱歉，${mediaType}资源加载超时，可能是网络原因或文件太大，请稍后再试～`;
  }
  if (msg.includes("文件不存在") || msg.includes("not found") || msg.includes("Not Found")) {
    return `抱歉，${mediaType}文件不存在或已失效，无法发送～`;
  }
  if (msg.includes("文件大小") || msg.includes("too large") || msg.includes("exceed")) {
    return `抱歉，${mediaType}文件太大了，超出了发送限制～`;
  }
  if (msg.includes("Network error") || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
    return `抱歉，网络连接异常，${mediaType}发送失败，请稍后再试～`;
  }
  return `抱歉，${mediaType}发送失败了，请稍后再试～`;
}

// ============ 内部标记过滤 ============

/**
 * 过滤内部标记（如 [[reply_to: xxx]]）
 * 这些标记可能被 AI 错误地学习并输出，需要在发送前移除
 */
function filterInternalMarkers(text: string): string {
  if (!text) return text;
  
  // 过滤 [[xxx: yyy]] 格式的内部标记
  // 例如: [[reply_to: ROBOT1.0_kbc...]]
  let result = text.replace(/\[\[[a-z_]+:\s*[^\]]*\]\]/gi, "");
  
  // 清理可能产生的多余空行
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  
  return result;
}

export interface GatewayContext {
  account: ResolvedQQBotAccount;
  abortSignal: AbortSignal;
  cfg: unknown;
  onReady?: (data: unknown) => void;
  onError?: (error: Error) => void;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

/**
 * 消息队列项类型（用于异步处理消息，防止阻塞心跳）
 */
interface QueuedMessage {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string; voice_wav_url?: string; asr_refer_text?: string }>;
  /** 被引用消息的 refIdx（用户引用了哪条历史消息） */
  refMsgIdx?: string;
  /** 当前消息自身的 refIdx（供将来被引用） */
  msgIdx?: string;
}

/**
 * 从 message_scene.ext 数组中解析引用索引
 * ext 格式示例: ["", "ref_msg_idx=REFIDX_xxx", "msg_idx=REFIDX_yyy"]
 */
function parseRefIndices(ext?: string[]): { refMsgIdx?: string; msgIdx?: string } {
  if (!ext || ext.length === 0) return {};
  let refMsgIdx: string | undefined;
  let msgIdx: string | undefined;
  for (const item of ext) {
    if (item.startsWith("ref_msg_idx=")) {
      refMsgIdx = item.slice("ref_msg_idx=".length);
    } else if (item.startsWith("msg_idx=")) {
      msgIdx = item.slice("msg_idx=".length);
    }
  }
  return { refMsgIdx, msgIdx };
}

/**
 * 从附件列表中构建附件摘要（用于引用索引缓存）
 */
function buildAttachmentSummaries(
  attachments?: Array<{ content_type: string; url: string; filename?: string; voice_wav_url?: string }>,
  localPaths?: Array<string | null>,
): RefAttachmentSummary[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((att, idx) => {
    const ct = att.content_type?.toLowerCase() ?? "";
    let type: RefAttachmentSummary["type"] = "unknown";
    if (ct.startsWith("image/")) type = "image";
    else if (ct === "voice" || ct.startsWith("audio/") || ct.includes("silk") || ct.includes("amr")) type = "voice";
    else if (ct.startsWith("video/")) type = "video";
    else if (ct.startsWith("application/") || ct.startsWith("text/")) type = "file";
    return {
      type,
      filename: att.filename,
      contentType: att.content_type,
      localPath: localPaths?.[idx] ?? undefined,
    };
  });
}

/**
 * 启动图床服务器
 */
async function ensureImageServer(log?: GatewayContext["log"], publicBaseUrl?: string): Promise<string | null> {
  if (isImageServerRunning()) {
    return publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`;
  }

  try {
    const config: Partial<ImageServerConfig> = {
      port: IMAGE_SERVER_PORT,
      storageDir: IMAGE_SERVER_DIR,
      // 使用用户配置的公网地址，而不是 0.0.0.0
      baseUrl: publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`,
      ttlSeconds: 3600, // 1 小时过期
    };
    await startImageServer(config);
    log?.info(`[qqbot] Image server started on port ${IMAGE_SERVER_PORT}, baseUrl: ${config.baseUrl}`);
    return config.baseUrl!;
  } catch (err) {
    log?.error(`[qqbot] Failed to start image server: ${err}`);
    return null;
  }
}

/**
 * 启动 Gateway WebSocket 连接（带自动重连）
 * 支持流式消息发送
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  // 启动环境诊断（首次连接时执行）
  const diag = await runDiagnostics();
  if (diag.warnings.length > 0) {
    for (const w of diag.warnings) {
      log?.info(`[qqbot:${account.accountId}] ${w}`);
    }
  }

  // 初始化 API 配置（markdown 支持）
  initApiConfig({
    markdownSupport: account.markdownSupport,
  });
  log?.info(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport === true}`);

  // TTS 配置验证
  const ttsCfg = resolveTTSConfig(cfg as Record<string, unknown>);
  if (ttsCfg) {
    const maskedKey = ttsCfg.apiKey.length > 8
      ? `${ttsCfg.apiKey.slice(0, 4)}****${ttsCfg.apiKey.slice(-4)}`
      : "****";
    log?.info(`[qqbot:${account.accountId}] TTS configured: model=${ttsCfg.model}, voice=${ttsCfg.voice}, authStyle=${ttsCfg.authStyle ?? "bearer"}, baseUrl=${ttsCfg.baseUrl}`);
    log?.info(`[qqbot:${account.accountId}] TTS apiKey: ${maskedKey}${ttsCfg.queryParams ? `, queryParams=${JSON.stringify(ttsCfg.queryParams)}` : ""}${ttsCfg.speed !== undefined ? `, speed=${ttsCfg.speed}` : ""}`);
  } else {
    log?.info(`[qqbot:${account.accountId}] TTS not configured (voice messages will be unavailable)`);
  }

  // 如果配置了公网 URL，启动图床服务器
  let imageServerBaseUrl: string | null = null;
  if (account.imageServerBaseUrl) {
    // 使用用户配置的公网地址作为 baseUrl
    await ensureImageServer(log, account.imageServerBaseUrl);
    imageServerBaseUrl = account.imageServerBaseUrl;
    log?.info(`[qqbot:${account.accountId}] Image server enabled with URL: ${imageServerBaseUrl}`);
  } else {
    log?.info(`[qqbot:${account.accountId}] Image server disabled (no imageServerBaseUrl configured)`);
  }

  // 注册出站消息 refIdx 缓存钩子
  // 所有消息发送函数在拿到 QQ 回包后，如果含 ref_idx 则自动回调此处缓存
  onMessageSent((refIdx, meta) => {
    log?.info(`[qqbot:${account.accountId}] onMessageSent called: refIdx=${refIdx}, mediaType=${meta.mediaType}, ttsText=${meta.ttsText?.slice(0, 30)}`);
    const attachments: RefAttachmentSummary[] = [];
    if (meta.mediaType) {
      const localPath = meta.mediaLocalPath;
      const filename = localPath ? path.basename(localPath) : undefined;
      const attachment: RefAttachmentSummary = {
        type: meta.mediaType,
        ...(localPath ? { localPath } : {}),
        ...(filename ? { filename } : {}),
        ...(meta.mediaUrl ? { url: meta.mediaUrl } : {}),
      };
      if (meta.mediaType === "voice" && meta.ttsText) {
        attachment.transcript = meta.ttsText;
        attachment.transcriptSource = "tts";
        log?.info(`[qqbot:${account.accountId}] Saving voice transcript (TTS): ${meta.ttsText.slice(0, 50)}`);
      }
      attachments.push(attachment);
    }
    setRefIndex(refIdx, {
      content: (meta.text ?? "").slice(0, 500),
      senderId: account.accountId,
      senderName: account.accountId,
      timestamp: Date.now(),
      isBot: true,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    log?.info(`[qqbot:${account.accountId}] Cached outbound refIdx: ${refIdx}, attachments=${JSON.stringify(attachments)}`);
  });

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let lastConnectTime: number = 0; // 上次连接成功的时间
  let quickDisconnectCount = 0; // 连续快速断开次数
  let isConnecting = false; // 防止并发连接
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null; // 重连定时器
  let shouldRefreshToken = false; // 下次连接是否需要刷新 token
  let intentLevelIndex = 0; // 当前尝试的权限级别索引
  let lastSuccessfulIntentLevel = -1; // 上次成功的权限级别

  // ============ P1-2: 尝试从持久化存储恢复 Session ============
  // 传入当前 appId，如果 appId 已变更（换了机器人），旧 session 自动失效
  const savedSession = loadSession(account.accountId, account.appId);
  if (savedSession) {
    sessionId = savedSession.sessionId;
    lastSeq = savedSession.lastSeq;
    intentLevelIndex = savedSession.intentLevelIndex;
    lastSuccessfulIntentLevel = savedSession.intentLevelIndex;
    log?.info(`[qqbot:${account.accountId}] Restored session from storage: sessionId=${sessionId}, lastSeq=${lastSeq}, intentLevel=${intentLevelIndex}`);
  }

  // ============ 按用户并发的消息队列（同用户串行，跨用户并行） ============
  // 每个用户有独立队列，同一用户的消息串行处理（保持时序），
  // 不同用户的消息并行处理（互不阻塞）。
  const userQueues = new Map<string, QueuedMessage[]>(); // peerId → 消息队列
  const activeUsers = new Set<string>(); // 正在处理中的用户
  let messagesProcessed = 0;
  let handleMessageFnRef: ((msg: QueuedMessage) => Promise<void>) | null = null;
  let totalEnqueued = 0; // 全局已入队总数（用于溢出保护）

  // 获取消息的路由 key（决定并发隔离粒度）
  const getMessagePeerId = (msg: QueuedMessage): string => {
    if (msg.type === "guild") return `guild:${msg.channelId ?? "unknown"}`;
    if (msg.type === "group") return `group:${msg.groupOpenid ?? "unknown"}`;
    return `dm:${msg.senderId}`;
  };

  const enqueueMessage = (msg: QueuedMessage): void => {
    const peerId = getMessagePeerId(msg);
    let queue = userQueues.get(peerId);
    if (!queue) {
      queue = [];
      userQueues.set(peerId, queue);
    }

    // 单用户队列溢出保护
    if (queue.length >= PER_USER_QUEUE_SIZE) {
      const dropped = queue.shift();
      log?.error(`[qqbot:${account.accountId}] Per-user queue full for ${peerId}, dropping oldest message ${dropped?.messageId}`);
    }

    // 全局总量保护
    totalEnqueued++;
    if (totalEnqueued > MESSAGE_QUEUE_SIZE) {
      log?.error(`[qqbot:${account.accountId}] Global queue limit reached (${totalEnqueued}), message from ${peerId} may be delayed`);
    }

    queue.push(msg);
    log?.debug?.(`[qqbot:${account.accountId}] Message enqueued for ${peerId}, user queue: ${queue.length}, active users: ${activeUsers.size}`);

    // 如果该用户没有正在处理的消息，立即启动处理
    drainUserQueue(peerId);
  };

  // 处理指定用户队列中的消息（串行）
  const drainUserQueue = async (peerId: string): Promise<void> => {
    if (activeUsers.has(peerId)) return; // 该用户已有处理中的消息
    if (activeUsers.size >= MAX_CONCURRENT_USERS) {
      log?.info(`[qqbot:${account.accountId}] Max concurrent users (${MAX_CONCURRENT_USERS}) reached, ${peerId} will wait`);
      return; // 达到并发上限，等待其他用户处理完后触发
    }

    const queue = userQueues.get(peerId);
    if (!queue || queue.length === 0) {
      userQueues.delete(peerId);
      return;
    }

    activeUsers.add(peerId);

    try {
      while (queue.length > 0 && !isAborted) {
        const msg = queue.shift()!;
        totalEnqueued = Math.max(0, totalEnqueued - 1);
        try {
          if (handleMessageFnRef) {
            await handleMessageFnRef(msg);
            messagesProcessed++;
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message processor error for ${peerId}: ${err}`);
        }
      }
    } finally {
      activeUsers.delete(peerId);
      userQueues.delete(peerId);
      // 处理完后，检查是否有等待并发槽位的用户
      for (const [waitingPeerId, waitingQueue] of userQueues) {
        if (waitingQueue.length > 0 && !activeUsers.has(waitingPeerId)) {
          drainUserQueue(waitingPeerId);
          break; // 每次只唤醒一个，避免瞬间并发激增
        }
      }
    }
  };

  const startMessageProcessor = (handleMessageFn: (msg: QueuedMessage) => Promise<void>): void => {
    handleMessageFnRef = handleMessageFn;
    log?.info(`[qqbot:${account.accountId}] Message processor started (per-user concurrency, max ${MAX_CONCURRENT_USERS} users)`);
  };

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanup();
    // P1-1: 停止后台 Token 刷新
    stopBackgroundTokenRefresh(account.appId);
    // P1-3: 保存已知用户数据
    flushKnownUsers();
    // P1-4: 保存引用索引数据
    flushRefIndex();
  });

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (currentWs && (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)) {
      currentWs.close();
    }
    currentWs = null;
  };

  const getReconnectDelay = () => {
    const idx = Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1);
    return RECONNECT_DELAYS[idx];
  };

  const scheduleReconnect = (customDelay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log?.error(`[qqbot:${account.accountId}] Max reconnect attempts reached or aborted`);
      return;
    }

    // 取消已有的重连定时器
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const delay = customDelay ?? getReconnectDelay();
    reconnectAttempts++;
    log?.info(`[qqbot:${account.accountId}] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) {
        connect();
      }
    }, delay);
  };

  const connect = async () => {
    // 防止并发连接
    if (isConnecting) {
      log?.debug?.(`[qqbot:${account.accountId}] Already connecting, skip`);
      return;
    }
    isConnecting = true;

    try {
      cleanup();

      // 如果标记了需要刷新 token，则清除缓存
      if (shouldRefreshToken) {
        log?.info(`[qqbot:${account.accountId}] Refreshing token...`);
        clearTokenCache(account.appId);
        shouldRefreshToken = false;
      }
      
      const accessToken = await getAccessToken(account.appId, account.clientSecret);
      log?.info(`[qqbot:${account.accountId}] ✅ Access token obtained successfully`);
      const gatewayUrl = await getGatewayUrl(accessToken);

      log?.info(`[qqbot:${account.accountId}] Connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl);
      currentWs = ws;

      const pluginRuntime = getQQBotRuntime();

      // 处理收到的消息
      const handleMessage = async (event: {
        type: "c2c" | "guild" | "dm" | "group";
        senderId: string;
        senderName?: string;
        content: string;
        messageId: string;
        timestamp: string;
        channelId?: string;
        guildId?: string;
        groupOpenid?: string;
        attachments?: Array<{ content_type: string; url: string; filename?: string; voice_wav_url?: string; asr_refer_text?: string }>;
        refMsgIdx?: string;
        msgIdx?: string;
      }) => {

        log?.debug?.(`[qqbot:${account.accountId}] Received message: ${JSON.stringify(event)}`);
        log?.info(`[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`);
        if (event.attachments?.length) {
          log?.info(`[qqbot:${account.accountId}] Attachments: ${event.attachments.length}`);
        }

        pluginRuntime.channel.activity.record({
          channel: "qqbot",
          accountId: account.accountId,
          direction: "inbound",
        });

        // 发送输入状态提示（非关键，失败不影响主流程）
        try {
          let token = await getAccessToken(account.appId, account.clientSecret);
          try {
            await sendC2CInputNotify(token, event.senderId, event.messageId, 60);
          } catch (notifyErr) {
            const errMsg = String(notifyErr);
            if (errMsg.includes("token") || errMsg.includes("401") || errMsg.includes("11244")) {
              log?.info(`[qqbot:${account.accountId}] InputNotify token expired, refreshing...`);
              clearTokenCache(account.appId);
              token = await getAccessToken(account.appId, account.clientSecret);
              await sendC2CInputNotify(token, event.senderId, event.messageId, 60);
            } else {
              throw notifyErr;
            }
          }
          log?.info(`[qqbot:${account.accountId}] Sent input notify to ${event.senderId}`);
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] sendC2CInputNotify error: ${err}`);
        }

        const isGroupChat = event.type === "guild" || event.type === "group";
        // peerId 只放纯 ID，类型信息由 peer.kind 表达
        // 群聊：用 groupOpenid（框架根据 kind:"group" 区分）
        // 私聊：用 senderId（框架根据 dmScope 决定隔离粒度）
        const peerId = event.type === "guild" ? (event.channelId ?? "unknown")
                     : event.type === "group" ? (event.groupOpenid ?? "unknown")
                     : event.senderId;

        const route = pluginRuntime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "qqbot",
          accountId: account.accountId,
          peer: {
            kind: isGroupChat ? "group" : "direct",
            id: peerId,
          },
        });

        const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);

        // 组装消息体
        // 静态系统提示已移至 skills/qqbot-cron/SKILL.md 和 skills/qqbot-media/SKILL.md
        // BodyForAgent 只保留必要的动态上下文信息
        
        // ============ 用户标识信息 ============
        
        // 收集额外的系统提示（如果配置了账户级别的 systemPrompt）
        const systemPrompts: string[] = [];
        if (account.systemPrompt) {
          systemPrompts.push(account.systemPrompt);
        }
        
        // 处理附件（图片等）- 下载到本地供 clawdbot 访问
        let attachmentInfo = "";
        const imageUrls: string[] = [];
        const imageMediaTypes: string[] = [];
        const voiceAttachmentPaths: string[] = [];
        const voiceAttachmentUrls: string[] = [];
        const voiceAsrReferTexts: string[] = [];
        const voiceTranscripts: string[] = [];
        const voiceTranscriptSources: Array<"stt" | "asr" | "fallback"> = [];
        // 存到 .openclaw/qqbot 目录下的 downloads 文件夹
        const downloadDir = getQQBotDataDir("downloads");
        const attachmentLocalPaths: Array<string | null> = []; // 记录每个附件的本地路径（与 event.attachments 一一对应）
        
        if (event.attachments?.length) {
          const otherAttachments: string[] = [];
          
          for (const att of event.attachments) {
            // 修复 QQ 返回的 // 前缀 URL
            const attUrl = att.url?.startsWith("//") ? `https:${att.url}` : att.url;

            // 语音附件：优先下载 WAV（voice_wav_url），减少 SILK→WAV 转换
            const isVoice = isVoiceAttachment(att);
            const asrReferText = typeof att.asr_refer_text === "string" ? att.asr_refer_text.trim() : "";
            const wavUrl = isVoice && att.voice_wav_url
              ? (att.voice_wav_url.startsWith("//") ? `https:${att.voice_wav_url}` : att.voice_wav_url)
              : "";
            const voiceSourceUrl = wavUrl || attUrl;
            if (isVoice) {
              if (voiceSourceUrl) voiceAttachmentUrls.push(voiceSourceUrl);
              if (asrReferText) voiceAsrReferTexts.push(asrReferText);
            }
            let localPath: string | null = null;
            let audioPath: string | null = null; // 用于 STT 的音频路径

            if (isVoice && wavUrl) {
              const wavLocalPath = await downloadFile(wavUrl, downloadDir);
              if (wavLocalPath) {
                localPath = wavLocalPath;
                audioPath = wavLocalPath;
                log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename}, downloaded WAV directly (skip SILK→WAV)`);
              } else {
                log?.error(`[qqbot:${account.accountId}] Failed to download voice_wav_url, falling back to original URL`);
              }
            }

            // WAV 下载失败或不是语音附件：下载原始文件
            if (!localPath) {
              localPath = await downloadFile(attUrl, downloadDir, att.filename);
            }

            if (localPath) {
              if (att.content_type?.startsWith("image/")) {
                imageUrls.push(localPath);
                imageMediaTypes.push(att.content_type);
              } else if (isVoice) {
                voiceAttachmentPaths.push(localPath);
                // 语音消息处理：先检查 STT 是否可用，避免无意义的转换开销
                const sttCfg = resolveSTTConfig(cfg as Record<string, unknown>);
                if (!sttCfg) {
                  if (asrReferText) {
                    log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename} (STT not configured, using asr_refer_text fallback)`);
                    voiceTranscripts.push(asrReferText);
                    voiceTranscriptSources.push("asr");
                  } else {
                    log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename} (STT not configured, skipping transcription)`);
                    voiceTranscripts.push("[语音消息 - 语音识别未配置，无法转录]");
                    voiceTranscriptSources.push("fallback");
                  }
                } else {
                  // 如果还没有 WAV 路径（voice_wav_url 不可用），需要 SILK→WAV 转换
                  if (!audioPath) {
                    const sttFormats = account.config?.audioFormatPolicy?.sttDirectFormats;
                    log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename}, converting SILK→WAV...`);
                    try {
                      const wavResult = await convertSilkToWav(localPath, downloadDir);
                      if (wavResult) {
                        audioPath = wavResult.wavPath;
                        log?.info(`[qqbot:${account.accountId}] Voice converted: ${wavResult.wavPath} (${formatDuration(wavResult.duration)})`);
                      } else {
                        audioPath = localPath; // 转换失败，尝试用原始文件
                      }
                    } catch (convertErr) {
                      log?.error(`[qqbot:${account.accountId}] Voice conversion failed: ${convertErr}`);
                      if (asrReferText) {
                        log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename} (using asr_refer_text fallback after convert failure)`);
                        voiceTranscripts.push(asrReferText);
                        voiceTranscriptSources.push("asr");
                      } else {
                        voiceTranscripts.push("[语音消息 - 格式转换失败]");
                        voiceTranscriptSources.push("fallback");
                      }
                      continue;
                    }
                  }

                  // STT 转录
                  try {
                    const transcript = await transcribeAudio(audioPath!, cfg as Record<string, unknown>);
                    if (transcript) {
                      log?.info(`[qqbot:${account.accountId}] STT transcript: ${transcript.slice(0, 100)}...`);
                      voiceTranscripts.push(transcript);
                      voiceTranscriptSources.push("stt");
                    } else if (asrReferText) {
                      log?.info(`[qqbot:${account.accountId}] STT returned empty result, using asr_refer_text fallback`);
                      voiceTranscripts.push(asrReferText);
                      voiceTranscriptSources.push("asr");
                    } else {
                      log?.info(`[qqbot:${account.accountId}] STT returned empty result`);
                      voiceTranscripts.push("[语音消息 - 转录结果为空]");
                      voiceTranscriptSources.push("fallback");
                    }
                  } catch (sttErr) {
                    log?.error(`[qqbot:${account.accountId}] STT failed: ${sttErr}`);
                    if (asrReferText) {
                      log?.info(`[qqbot:${account.accountId}] Voice attachment: ${att.filename} (using asr_refer_text fallback after STT failure)`);
                      voiceTranscripts.push(asrReferText);
                      voiceTranscriptSources.push("asr");
                    } else {
                      voiceTranscripts.push("[语音消息 - 转录失败]");
                      voiceTranscriptSources.push("fallback");
                    }
                  }
                }
              } else {
                otherAttachments.push(`[附件: ${localPath}]`);
              }
              log?.info(`[qqbot:${account.accountId}] Downloaded attachment to: ${localPath}`);
              attachmentLocalPaths.push(localPath);
            } else {
              // 下载失败，fallback 到原始 URL
              log?.error(`[qqbot:${account.accountId}] Failed to download: ${attUrl}`);
              attachmentLocalPaths.push(null);
              if (att.content_type?.startsWith("image/")) {
                imageUrls.push(attUrl);
                imageMediaTypes.push(att.content_type);
              } else if (isVoice && asrReferText) {
                log?.info(`[qqbot:${account.accountId}] Voice attachment download failed, using asr_refer_text fallback`);
                voiceTranscripts.push(asrReferText);
                voiceTranscriptSources.push("asr");
              } else {
                otherAttachments.push(`[附件: ${att.filename ?? att.content_type}] (下载失败)`);
              }
            }
          }
          
          if (otherAttachments.length > 0) {
            attachmentInfo += "\n" + otherAttachments.join("\n");
          }
        }
        
        // 语音转录文本注入到用户消息中
        let voiceText = "";
        const hasAsrReferFallback = voiceTranscriptSources.includes("asr");
        if (voiceTranscripts.length > 0) {
          voiceText = voiceTranscripts.length === 1
            ? `${voiceTranscriptSources[0] === "asr" ? "[语音消息(ASR兜底，可能不准确)]" : "[语音消息]"} ${voiceTranscripts[0]}`
            : voiceTranscripts.map((t, i) => {
                const prefix = voiceTranscriptSources[i] === "asr"
                  ? `[语音${i + 1}(ASR兜底，可能不准确)]`
                  : `[语音${i + 1}]`;
                return `${prefix} ${t}`;
              }).join("\n");
        }

        // 解析 QQ 表情标签，将 <faceType=...,ext="base64"> 替换为 【表情: 中文名】
        const parsedContent = parseFaceTags(event.content);
        const userContent = voiceText
          ? (parsedContent.trim() ? `${parsedContent}\n${voiceText}` : voiceText) + attachmentInfo
          : parsedContent + attachmentInfo;

        // ============ 引用消息处理 ============
        let replyToId: string | undefined;
        let replyToBody: string | undefined;
        let replyToSender: string | undefined;
        let replyToIsQuote = false;

        // 1. 查找被引用消息
        if (event.refMsgIdx) {
          const refEntry = getRefIndex(event.refMsgIdx);
          if (refEntry) {
            replyToId = event.refMsgIdx;
            replyToBody = formatRefEntryForAgent(refEntry);
            replyToSender = refEntry.senderName ?? refEntry.senderId;
            replyToIsQuote = true;
            log?.info(`[qqbot:${account.accountId}] Quote detected: refMsgIdx=${event.refMsgIdx}, sender=${replyToSender}, content="${replyToBody.slice(0, 80)}..."`);
          } else {
            log?.info(`[qqbot:${account.accountId}] Quote detected but refMsgIdx not in cache: ${event.refMsgIdx}`);
            replyToId = event.refMsgIdx;
            replyToIsQuote = true;
          }
        }

        // 2. 缓存当前消息自身的 msgIdx（供将来被引用时查找）
        const currentMsgIdx = event.msgIdx;
        if (currentMsgIdx) {
          const attSummaries = buildAttachmentSummaries(event.attachments, attachmentLocalPaths);
          if (attSummaries && voiceTranscripts.length > 0) {
            let voiceIdx = 0;
            for (const att of attSummaries) {
              if (att.type === "voice" && voiceIdx < voiceTranscripts.length) {
                att.transcript = voiceTranscripts[voiceIdx];
                if (voiceIdx < voiceTranscriptSources.length) {
                  att.transcriptSource = voiceTranscriptSources[voiceIdx] as RefAttachmentSummary["transcriptSource"];
                }
                voiceIdx++;
              }
            }
          }
          setRefIndex(currentMsgIdx, {
            content: parsedContent,
            senderId: event.senderId,
            senderName: event.senderName,
            timestamp: new Date(event.timestamp).getTime(),
            attachments: attSummaries,
          });
          log?.info(`[qqbot:${account.accountId}] Cached msgIdx=${currentMsgIdx} for future reference (source: message_scene.ext)`);
        }

        // Body: 展示用的用户原文（Web UI 看到的）
        const body = pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "qqbot",
          from: event.senderName ?? event.senderId,
          timestamp: new Date(event.timestamp).getTime(),
          body: userContent,
          chatType: isGroupChat ? "group" : "direct",
          sender: {
            id: event.senderId,
            name: event.senderName,
          },
          envelope: envelopeOptions,
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
        });
        
        // BodyForAgent: AI 实际看到的完整上下文（动态数据 + 系统提示 + 用户输入）
        const nowMs = Date.now();

        // 构建媒体附件纯数据描述（图片 + 语音统一列出）
        const uniqueVoicePaths = [...new Set(voiceAttachmentPaths)];
        const uniqueVoiceUrls = [...new Set(voiceAttachmentUrls)];
        const uniqueVoiceAsrReferTexts = [...new Set(voiceAsrReferTexts)].filter(Boolean);
        const sttTranscriptCount = voiceTranscriptSources.filter((s) => s === "stt").length;
        const asrFallbackCount = voiceTranscriptSources.filter((s) => s === "asr").length;
        const fallbackCount = voiceTranscriptSources.filter((s) => s === "fallback").length;
        if (voiceAttachmentPaths.length > 0 || voiceAttachmentUrls.length > 0 || uniqueVoiceAsrReferTexts.length > 0) {
          const asrPreview = uniqueVoiceAsrReferTexts.length > 0
            ? uniqueVoiceAsrReferTexts[0].slice(0, 50)
            : "";
          log?.info(
            `[qqbot:${account.accountId}] Voice input summary: local=${uniqueVoicePaths.length}, remote=${uniqueVoiceUrls.length}, `
            + `asrReferTexts=${uniqueVoiceAsrReferTexts.length}, transcripts=${voiceTranscripts.length}, `
            + `source(stt/asr/fallback)=${sttTranscriptCount}/${asrFallbackCount}/${fallbackCount}`
            + (asrPreview ? `, asr_preview="${asrPreview}${uniqueVoiceAsrReferTexts[0].length > 50 ? "..." : ""}"` : "")
          );
        }
        let receivedMediaSection = "";
        if (imageUrls.length > 0 || uniqueVoicePaths.length > 0 || uniqueVoiceUrls.length > 0) {
          const mediaSections: string[] = [];
          if (imageUrls.length > 0) {
            const imageEntries = imageUrls.map((p, i) => `  - ${p} (${imageMediaTypes[i] || "unknown"})`);
            mediaSections.push(`- 图片附件:\n${imageEntries.join("\n")}`);
          }
          if (uniqueVoicePaths.length > 0 || uniqueVoiceUrls.length > 0) {
            const voiceEntries = [
              ...uniqueVoicePaths.map((p) => `  - ${p} (local audio)`),
              ...uniqueVoiceUrls.map((u) => `  - ${u} (remote audio)`),
            ];
            mediaSections.push(`- 语音附件:\n${voiceEntries.join("\n")}`);
          }
          receivedMediaSection = `\n${mediaSections.join("\n")}`;
        }

        // AI 看到的投递地址必须带完整前缀（qqbot:c2c: / qqbot:group:）
        const qualifiedTarget = isGroupChat ? `qqbot:group:${event.groupOpenid}` : `qqbot:c2c:${event.senderId}`;

        // 动态检测 TTS/STT 配置状态
        const hasTTS = !!resolveTTSConfig(cfg as Record<string, unknown>);
        const hasSTT = !!resolveSTTConfig(cfg as Record<string, unknown>);

        // 语音能力说明：<qqvoice> 标签本身只负责发送已有的音频文件，不依赖插件 TTS。
        // TTS 只是生成音频文件的一种方式，框架侧的 TTS 工具（如 audio_speech）也能生成。
        // 因此始终暴露 <qqvoice> 能力，但根据 TTS 状态给出不同的使用指引。
        const ttsHint = hasTTS
          ? `6. 🎤 插件 TTS 已启用: 如果你有 TTS 工具（如 audio_speech），可用它生成音频文件后用 <qqvoice> 发送`
          : `6. ⚠️ 插件 TTS 未配置: 如果你有 TTS 工具（如 audio_speech），仍可用它生成音频文件后用 <qqvoice> 发送；若无 TTS 工具，则无法主动生成语音`;
        const sttHint = hasSTT
          ? `\n7. 插件侧 STT 已配置，用户发送的语音消息会尽量自动转录`
          : `\n7. 插件侧 STT 未配置，插件不会自动转录语音消息`;
        const asrFallbackHint = hasAsrReferFallback
          ? `\n8. 本条消息包含平台返回的 asr_refer_text 兜底文本（低置信度）。理解用户意图时可参考，但如关键信息不明确应先追问确认。`
          : "";
        const voiceForwardHint = uniqueVoicePaths.length > 0 || uniqueVoiceUrls.length > 0
          ? `\n9. 本条消息已附带语音文件路径/URL。若你具备 STT 能力（框架能力或 STT skill），优先直接转写音频；若无 STT 能力或转写失败，再使用 asr_refer_text（若存在）作为兜底。`
          : "";
        const voiceSection = `

【发送语音 - 必须遵守】
1. 发语音方法: 在回复文本中写 <qqvoice>本地音频文件路径</qqvoice>，系统自动处理
2. 示例: "来听听吧！ <qqvoice>/tmp/tts/voice.mp3</qqvoice>"
3. 支持格式: .silk, .slk, .slac, .amr, .wav, .mp3, .ogg, .pcm
4. ⚠️ <qqvoice> 只用于语音文件，图片请用 <qqimg>；两者不要混用
5. 发送语音时，不要重复输出语音中已朗读的文字内容；语音前后的文字应是补充信息而非语音的文字版重复
${ttsHint}${sttHint}${asrFallbackHint}${voiceForwardHint}`;

        const voiceAsrSection = uniqueVoiceAsrReferTexts.length > 0
          ? `\n- 语音ASR兜底文本:\n${uniqueVoiceAsrReferTexts.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}`
          : "";

        const contextInfo = `你正在通过 QQ 与用户对话。

【会话上下文】
- 用户: ${event.senderName || "未知"} (${event.senderId})
- 场景: ${isGroupChat ? "群聊" : "私聊"}${isGroupChat ? ` (群组: ${event.groupOpenid})` : ""}
- 消息ID: ${event.messageId}
- 投递目标: ${qualifiedTarget}${receivedMediaSection}${voiceAsrSection}
- 当前时间戳(ms): ${nowMs}
- 定时提醒投递地址: channel=qqbot, to=${qualifiedTarget}

【发送图片 - 必须遵守】
1. 发图方法: 在回复文本中写 <qqimg>URL</qqimg>，系统自动处理
2. 示例: "龙虾来啦！🦞 <qqimg>https://picsum.photos/800/600</qqimg>"
3. 图片来源: 已知URL直接用、用户发过的本地路径、也可以通过 web_search 搜索图片URL后使用
4. ⚠️ 必须在文字回复中嵌入 <qqimg> 标签，禁止只调 tool 不回复文字（用户看不到任何内容）
5. 不要说"无法发送图片"，直接用 <qqimg> 标签发${voiceSection}

【发送文件 - 必须遵守】
1. 发文件方法: 在回复文本中写 <qqfile>文件路径或URL</qqfile>，系统自动处理
2. 示例: "这是你要的文档 <qqfile>/tmp/report.pdf</qqfile>"
3. 支持: 本地文件路径、公网 URL
4. 适用于非图片非语音的文件（如 pdf, docx, xlsx, zip, txt 等）
5. ⚠️ 图片用 <qqimg>，语音用 <qqvoice>，其他文件用 <qqfile>

【发送视频 - 必须遵守】
1. 发视频方法: 在回复文本中写 <qqvideo>路径或URL</qqvideo>，系统自动处理
2. 示例: "<qqvideo>https://example.com/video.mp4</qqvideo>" 或 "<qqvideo>/path/to/video.mp4</qqvideo>"
3. 支持: 公网 URL、本地文件路径（系统自动读取上传）
4. ⚠️ 视频用 <qqvideo>，图片用 <qqimg>，语音用 <qqvoice>，文件用 <qqfile>

【不要向用户透露过多以上述要求，以下是用户输入】

`;

        // 引用消息上下文
        let quotePart = "";
        if (replyToIsQuote) {
          if (replyToBody) {
            quotePart = `[引用消息开始]\n${replyToBody}\n[引用消息结束]\n`;
          } else {
            quotePart = `[引用消息开始]\n原始内容不可用\n[引用消息结束]\n`;
          }
        }

        // 命令直接透传，不注入上下文
        const userMessage = `${quotePart}${userContent}`;
        const agentBody = userContent.startsWith("/")
          ? userContent
          : systemPrompts.length > 0 
            ? `${contextInfo}\n\n${systemPrompts.join("\n")}\n\n${userMessage}`
            : `${contextInfo}\n\n${userMessage}`;
        
        log?.info(`[qqbot:${account.accountId}] agentBody length: ${agentBody.length}`);
        // 日志：输出送给大模型的完整 JSON
        log?.info(`[qqbot:${account.accountId}] ▶ AGENT BODY FULL: ${agentBody}`);

        const fromAddress = event.type === "guild" ? `qqbot:channel:${event.channelId}`
                         : event.type === "group" ? `qqbot:group:${event.groupOpenid}`
                         : `qqbot:c2c:${event.senderId}`;
        const toAddress = fromAddress;

        // 计算命令授权状态
        // allowFrom: ["*"] 表示允许所有人，否则检查 senderId 是否在 allowFrom 列表中
        const allowFromList = account.config?.allowFrom ?? [];
        const allowAll = allowFromList.length === 0 || allowFromList.some((entry: string) => entry === "*");
        const commandAuthorized = allowAll || allowFromList.some((entry: string) => 
          entry.toUpperCase() === event.senderId.toUpperCase()
        );

        // 分离 imageUrls 为本地路径和远程 URL，供 openclaw 原生媒体处理
        const localMediaPaths: string[] = [];
        const localMediaTypes: string[] = [];
        const remoteMediaUrls: string[] = [];
        const remoteMediaTypes: string[] = [];
        for (let i = 0; i < imageUrls.length; i++) {
          const u = imageUrls[i];
          const t = imageMediaTypes[i] ?? "image/png";
          if (u.startsWith("http://") || u.startsWith("https://")) {
            remoteMediaUrls.push(u);
            remoteMediaTypes.push(t);
          } else {
            localMediaPaths.push(u);
            localMediaTypes.push(t);
          }
        }

        const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
          Body: body,
          BodyForAgent: agentBody,
          RawBody: event.content,
          CommandBody: event.content,
          From: fromAddress,
          To: toAddress,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: isGroupChat ? "group" : "direct",
          SenderId: event.senderId,
          SenderName: event.senderName,
          Provider: "qqbot",
          Surface: "qqbot",
          MessageSid: event.messageId,
          Timestamp: new Date(event.timestamp).getTime(),
          OriginatingChannel: "qqbot",
          OriginatingTo: toAddress,
          QQChannelId: event.channelId,
          QQGuildId: event.guildId,
          QQGroupOpenid: event.groupOpenid,
          QQVoiceAsrReferAvailable: hasAsrReferFallback,
          QQVoiceTranscriptSources: voiceTranscriptSources,
          QQVoiceAttachmentPaths: uniqueVoicePaths,
          QQVoiceAttachmentUrls: uniqueVoiceUrls,
          QQVoiceAsrReferTexts: uniqueVoiceAsrReferTexts,
          QQVoiceInputStrategy: "prefer_audio_stt_then_asr_fallback",
          CommandAuthorized: commandAuthorized,
          // 传递媒体路径和 URL，使 openclaw 原生媒体处理（视觉等）能正常工作
          ...(localMediaPaths.length > 0 ? {
            MediaPaths: localMediaPaths,
            MediaPath: localMediaPaths[0],
            MediaTypes: localMediaTypes,
            MediaType: localMediaTypes[0],
          } : {}),
          ...(remoteMediaUrls.length > 0 ? {
            MediaUrls: remoteMediaUrls,
            MediaUrl: remoteMediaUrls[0],
          } : {}),
          // 引用消息上下文（对齐 Telegram/Discord 的 ReplyTo 字段）
          ...(replyToId ? {
            ReplyToId: replyToId,
            ReplyToBody: replyToBody,
            ReplyToSender: replyToSender,
            ReplyToIsQuote: replyToIsQuote,
          } : {}),
        });

        // 发送消息的辅助函数，带 token 过期重试
        const sendWithTokenRetry = async (sendFn: (token: string) => Promise<unknown>) => {
          try {
            const token = await getAccessToken(account.appId, account.clientSecret);
            await sendFn(token);
          } catch (err) {
            const errMsg = String(err);
            // 如果是 token 相关错误，清除缓存重试一次
            if (errMsg.includes("401") || errMsg.includes("token") || errMsg.includes("access_token")) {
              log?.info(`[qqbot:${account.accountId}] Token may be expired, refreshing...`);
              clearTokenCache(account.appId);
              const newToken = await getAccessToken(account.appId, account.clientSecret);
              await sendFn(newToken);
            } else {
              throw err;
            }
          }
        };

        // 发送错误提示的辅助函数
        const sendErrorMessage = async (errorText: string) => {
          try {
            await sendWithTokenRetry(async (token) => {
              if (event.type === "c2c") {
                await sendC2CMessage(token, event.senderId, errorText, event.messageId);
              } else if (event.type === "group" && event.groupOpenid) {
                await sendGroupMessage(token, event.groupOpenid, errorText, event.messageId);
              } else if (event.channelId) {
                await sendChannelMessage(token, event.channelId, errorText, event.messageId);
              }
            });
          } catch (sendErr) {
            log?.error(`[qqbot:${account.accountId}] Failed to send error message: ${sendErr}`);
          }
        };

        try {
          const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);

          // 追踪是否有响应
          let hasResponse = false;
          let hasBlockResponse = false; // 是否收到了面向用户的 block 回复
          let toolDeliverCount = 0; // tool deliver 计数
          const toolTexts: string[] = []; // 收集所有 tool deliver 文本（用于格式化展示）
          let toolFallbackSent = false; // 兜底消息是否已发送（只发一次）
          const responseTimeout = 120000; // 120秒超时（2分钟，与 TTS/文件生成超时对齐）
          const toolOnlyTimeout = 60000; // tool-only 兜底超时：60秒内没有 block 就兜底
          const maxToolRenewals = 3; // tool 续期上限：最多续期 3 次（总等待 = 60s × 3 = 180s）
          let toolRenewalCount = 0; // 已续期次数
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          let toolOnlyTimeoutId: ReturnType<typeof setTimeout> | null = null;

          // 格式化 tool 兜底消息：极简，只展示工具原始参数
          const formatToolFallback = (): string => {
            if (toolTexts.length === 0) {
              return "🔧 调用工具中…";
            }
            const recentTools = toolTexts.slice(-3);
            const totalLen = recentTools.reduce((s, t) => s + t.length, 0);
            if (totalLen > 1800) {
              const last = recentTools[recentTools.length - 1]!;
              return `🔧 调用工具中…\n\`\`\`\n${last.slice(0, 1500)}\n\`\`\``;
            }
            const toolBlock = recentTools.join("\n---\n");
            return `🔧 调用工具中…\n\`\`\`\n${toolBlock}\n\`\`\``;
          };

          const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
              if (!hasResponse) {
                reject(new Error("Response timeout"));
              }
            }, responseTimeout);
          });

          // ============ 消息发送目标 ============
          // 确定发送目标
          const targetTo = event.type === "c2c" ? event.senderId
                        : event.type === "group" ? `group:${event.groupOpenid}`
                        : `channel:${event.channelId}`;

          // ============ 引用回复 ============
          // 机器人回复时，引用用户当前发来的消息（event.msgIdx 是用户消息自身的 REFIDX）
          // 只在第一条回复消息上附加引用，后续消息不重复引用
          const quoteRef = event.msgIdx;
          let quoteRefUsed = false;
          const consumeQuoteRef = (): string | undefined => {
            if (quoteRef && !quoteRefUsed) {
              quoteRefUsed = true;
              return quoteRef;
            }
            return undefined;
          };

          const dispatchPromise = pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,
              deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }, info: { kind: string }) => {
                hasResponse = true;

                log?.info(`[qqbot:${account.accountId}] deliver called, kind: ${info.kind}, payload keys: ${Object.keys(payload).join(", ")}`);

                // ============ 跳过工具调用的中间结果（带兜底保护） ============
                if (info.kind === "tool") {
                  toolDeliverCount++;
                  const toolText = (payload.text ?? "").trim();
                  if (toolText) {
                    toolTexts.push(toolText);
                  }
                  log?.info(`[qqbot:${account.accountId}] Skipping tool result deliver #${toolDeliverCount} (intermediate, not user-facing), text length: ${toolText.length}`);

                  // 兜底已发送，不再续期
                  if (toolFallbackSent) {
                    return;
                  }

                  // tool-only 超时保护：收到 tool 但迟迟没有 block 时，启动兜底定时器
                  // 续期有上限（maxToolRenewals 次），防止无限工具调用永远不触发兜底
                  if (toolOnlyTimeoutId) {
                    if (toolRenewalCount < maxToolRenewals) {
                      clearTimeout(toolOnlyTimeoutId);
                      toolRenewalCount++;
                      log?.info(`[qqbot:${account.accountId}] Tool-only timer renewed (${toolRenewalCount}/${maxToolRenewals})`);
                    } else {
                      // 已达续期上限，不再重置，等定时器自然触发兜底
                      log?.info(`[qqbot:${account.accountId}] Tool-only timer renewal limit reached (${maxToolRenewals}), waiting for timeout`);
                      return;
                    }
                  }
                  toolOnlyTimeoutId = setTimeout(async () => {
                    if (!hasBlockResponse && !toolFallbackSent) {
                      toolFallbackSent = true;
                      log?.error(`[qqbot:${account.accountId}] Tool-only timeout: ${toolDeliverCount} tool deliver(s) but no block within ${toolOnlyTimeout / 1000}s, sending fallback`);
                      const fallback = formatToolFallback();
                      try {
                        await sendWithTokenRetry(async (token) => {
                          if (event.type === "c2c") {
                            await sendC2CMessage(token, event.senderId, fallback, event.messageId);
                          } else if (event.type === "group" && event.groupOpenid) {
                            await sendGroupMessage(token, event.groupOpenid, fallback, event.messageId);
                          } else if (event.channelId) {
                            await sendChannelMessage(token, event.channelId, fallback, event.messageId);
                          }
                        });
                      } catch (sendErr) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send tool-only fallback: ${sendErr}`);
                      }
                    }
                  }, toolOnlyTimeout);
                  return;
                }

                // 收到 block 回复，清除所有超时定时器
                hasBlockResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }
                if (toolOnlyTimeoutId) {
                  clearTimeout(toolOnlyTimeoutId);
                  toolOnlyTimeoutId = null;
                }
                if (toolDeliverCount > 0) {
                  log?.info(`[qqbot:${account.accountId}] Block deliver after ${toolDeliverCount} tool deliver(s)`);
                }

                let replyText = payload.text ?? "";
                
                // ============ 媒体标签解析 ============
                // 支持四种标签:
                //   <qqimg>路径</qqimg> 或 <qqimg>路径</img>  — 图片
                //   <qqvoice>路径</qqvoice>                   — 语音
                //   <qqvideo>路径或URL</qqvideo>                — 视频
                //   <qqfile>路径</qqfile>                     — 文件
                // 按文本中出现的位置统一构建发送队列，保持顺序
                
                // 预处理：纠正小模型常见的标签拼写错误和格式问题
                replyText = normalizeMediaTags(replyText);
                
                const mediaTagRegex = /<(qqimg|qqvoice|qqvideo|qqfile)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi;
                const mediaTagMatches = [...replyText.matchAll(mediaTagRegex)];
                
                if (mediaTagMatches.length > 0) {
                  const imgCount = mediaTagMatches.filter(m => m[1]!.toLowerCase() === "qqimg").length;
                  const voiceCount = mediaTagMatches.filter(m => m[1]!.toLowerCase() === "qqvoice").length;
                  const videoCount = mediaTagMatches.filter(m => m[1]!.toLowerCase() === "qqvideo").length;
                  const fileCount = mediaTagMatches.filter(m => m[1]!.toLowerCase() === "qqfile").length;
                  log?.info(`[qqbot:${account.accountId}] Detected media tags: ${imgCount} <qqimg>, ${voiceCount} <qqvoice>, ${videoCount} <qqvideo>, ${fileCount} <qqfile>`);
                  
                  // 构建发送队列
                  const sendQueue: Array<{ type: "text" | "image" | "voice" | "video" | "file"; content: string }> = [];
                  
                  let lastIndex = 0;
                  const mediaTagRegexWithIndex = /<(qqimg|qqvoice|qqvideo|qqfile)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi;
                  let match;
                  
                  while ((match = mediaTagRegexWithIndex.exec(replyText)) !== null) {
                    // 添加标签前的文本
                    const textBefore = replyText.slice(lastIndex, match.index).replace(/\n{3,}/g, "\n\n").trim();
                    if (textBefore) {
                      sendQueue.push({ type: "text", content: filterInternalMarkers(textBefore) });
                    }
                    
                    const tagName = match[1]!.toLowerCase(); // "qqimg" or "qqvoice" or "qqfile"
                    
                    // 剥离 MEDIA: 前缀（框架可能注入），展开 ~ 路径
                    let mediaPath = match[2]?.trim() ?? "";
                    if (mediaPath.startsWith("MEDIA:")) {
                      mediaPath = mediaPath.slice("MEDIA:".length);
                    }
                    mediaPath = normalizePath(mediaPath);

                    // 处理可能被模型转义的路径
                    // 1. 双反斜杠 -> 单反斜杠（Markdown 转义）
                    mediaPath = mediaPath.replace(/\\\\/g, "\\");

                    // 2. 八进制转义序列 + UTF-8 双重编码修复
                    try {
                      const hasOctal = /\\[0-7]{1,3}/.test(mediaPath);
                      const hasNonASCII = /[\u0080-\u00FF]/.test(mediaPath);

                      if (hasOctal || hasNonASCII) {
                        log?.debug?.(`[qqbot:${account.accountId}] Decoding path with mixed encoding: ${mediaPath}`);

                        // Step 1: 将八进制转义转换为字节
                        let decoded = mediaPath.replace(/\\([0-7]{1,3})/g, (_: string, octal: string) => {
                          return String.fromCharCode(parseInt(octal, 8));
                        });

                        // Step 2: 提取所有字节（包括 Latin-1 字符）
                        const bytes: number[] = [];
                        for (let i = 0; i < decoded.length; i++) {
                          const code = decoded.charCodeAt(i);
                          if (code <= 0xFF) {
                            bytes.push(code);
                          } else {
                            const charBytes = Buffer.from(decoded[i], 'utf8');
                            bytes.push(...charBytes);
                          }
                        }

                        // Step 3: 尝试按 UTF-8 解码
                        const buffer = Buffer.from(bytes);
                        const utf8Decoded = buffer.toString('utf8');

                        if (!utf8Decoded.includes('\uFFFD') || utf8Decoded.length < decoded.length) {
                          mediaPath = utf8Decoded;
                          log?.debug?.(`[qqbot:${account.accountId}] Successfully decoded path: ${mediaPath}`);
                        }
                      }
                    } catch (decodeErr) {
                      log?.error(`[qqbot:${account.accountId}] Path decode error: ${decodeErr}`);
                    }

                    if (mediaPath) {
                      if (tagName === "qqvoice") {
                        sendQueue.push({ type: "voice", content: mediaPath });
                        log?.info(`[qqbot:${account.accountId}] Found voice path in <qqvoice>: ${mediaPath}`);
                      } else if (tagName === "qqvideo") {
                        sendQueue.push({ type: "video", content: mediaPath });
                        log?.info(`[qqbot:${account.accountId}] Found video URL in <qqvideo>: ${mediaPath}`);
                      } else if (tagName === "qqfile") {
                        sendQueue.push({ type: "file", content: mediaPath });
                        log?.info(`[qqbot:${account.accountId}] Found file path in <qqfile>: ${mediaPath}`);
                      } else {
                        sendQueue.push({ type: "image", content: mediaPath });
                        log?.info(`[qqbot:${account.accountId}] Found image path in <qqimg>: ${mediaPath}`);
                      }
                    }
                    
                    lastIndex = match.index + match[0].length;
                  }
                  
                  // 添加最后一个标签后的文本
                  const textAfter = replyText.slice(lastIndex).replace(/\n{3,}/g, "\n\n").trim();
                  if (textAfter) {
                    sendQueue.push({ type: "text", content: filterInternalMarkers(textAfter) });
                  }
                  
                  log?.info(`[qqbot:${account.accountId}] Send queue: ${sendQueue.map(item => item.type).join(" -> ")}`);
                  
                  // 按顺序发送
                  for (const item of sendQueue) {
                    if (item.type === "text") {
                      // 发送文本
                      try {
                        await sendWithTokenRetry(async (token) => {
                          const ref = consumeQuoteRef();
                          if (event.type === "c2c") {
                            await sendC2CMessage(token, event.senderId, item.content, event.messageId, ref);
                          } else if (event.type === "group" && event.groupOpenid) {
                            await sendGroupMessage(token, event.groupOpenid, item.content, event.messageId, ref);
                          } else if (event.channelId) {
                            await sendChannelMessage(token, event.channelId, item.content, event.messageId, ref);
                          }
                        });
                        log?.info(`[qqbot:${account.accountId}] Sent text: ${item.content.slice(0, 50)}...`);
                      } catch (err) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send text: ${err}`);
                      }
                    } else if (item.type === "image") {
                      // 发送图片（展开 ~ 路径）
                      const imagePath = normalizePath(item.content);
                      try {
                        let imageUrl = imagePath;
                        
                        // 判断是本地文件还是 URL
                        const isLocalPath = isLocalFilePath(imagePath);
                        const isHttpUrl = imagePath.startsWith("http://") || imagePath.startsWith("https://");
                        
                        if (isLocalPath) {
                          // 本地文件：转换为 Base64 Data URL
                          if (!(await fileExistsAsync(imagePath))) {
                            log?.error(`[qqbot:${account.accountId}] Image file not found: ${imagePath}`);
                            await sendErrorMessage(`图片文件不存在: ${imagePath}`);
                            continue;
                          }
                          
                          // 文件大小校验
                          const imgSizeCheck = checkFileSize(imagePath);
                          if (!imgSizeCheck.ok) {
                            log?.error(`[qqbot:${account.accountId}] ${imgSizeCheck.error}`);
                            await sendErrorMessage(imgSizeCheck.error!);
                            continue;
                          }
                          
                          // 大文件进度提示
                          if (isLargeFile(imgSizeCheck.size)) {
                            try {
                              await sendWithTokenRetry(async (token) => {
                                const hint = `⏳ 正在上传图片 (${formatFileSize(imgSizeCheck.size)})...`;
                                if (event.type === "c2c") {
                                  await sendC2CMessage(token, event.senderId, hint, event.messageId);
                                } else if (event.type === "group" && event.groupOpenid) {
                                  await sendGroupMessage(token, event.groupOpenid, hint, event.messageId);
                                }
                              });
                            } catch {}
                          }
                          
                          const fileBuffer = await readFileAsync(imagePath);
                          const base64Data = fileBuffer.toString("base64");
                          const ext = path.extname(imagePath).toLowerCase();
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
                            log?.error(`[qqbot:${account.accountId}] Unsupported image format: ${ext}`);
                            await sendErrorMessage(`不支持的图片格式: ${ext}`);
                            continue;
                          }
                          imageUrl = `data:${mimeType};base64,${base64Data}`;
                          log?.info(`[qqbot:${account.accountId}] Converted local image to Base64 (size: ${formatFileSize(fileBuffer.length)})`);
                        } else if (!isHttpUrl) {
                          log?.error(`[qqbot:${account.accountId}] Invalid image path (not local or URL): ${imagePath}`);
                          continue;
                        }
                        
                        // 发送图片
                        await sendWithTokenRetry(async (token) => {
                          if (event.type === "c2c") {
                            await sendC2CImageMessage(token, event.senderId, imageUrl, event.messageId);
                          } else if (event.type === "group" && event.groupOpenid) {
                            await sendGroupImageMessage(token, event.groupOpenid, imageUrl, event.messageId);
                          } else if (event.channelId) {
                            // 频道使用 Markdown 格式（如果是公网 URL）
                            if (isHttpUrl) {
                              await sendChannelMessage(token, event.channelId, `![](${imagePath})`, event.messageId);
                            } else {
                              // 频道不支持富媒体 Base64
                              log?.info(`[qqbot:${account.accountId}] Channel does not support rich media for local images`);
                            }
                          }
                        });
                        log?.info(`[qqbot:${account.accountId}] Sent image via <qqimg> tag: ${imagePath.slice(0, 60)}...`);
                      } catch (err) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send image from <qqimg>: ${err}`);
                        await sendErrorMessage(`图片发送失败，图片似乎不存在哦，图片路径：${imagePath}`);
                      }
                    } else if (item.type === "voice") {
                      // 发送语音文件（展开 ~ 路径）
                      const voicePath = normalizePath(item.content);
                      try {
                        // 等待文件就绪（TTS 工具异步生成，文件可能还没写完）
                        const fileSize = await waitForFile(voicePath);
                        if (fileSize === 0) {
                          log?.error(`[qqbot:${account.accountId}] Voice file not ready after waiting: ${voicePath}`);
                          await sendErrorMessage(`语音生成失败，请稍后重试`);
                          continue;
                        }

                        // 转换为 SILK 格式（QQ Bot API 语音只支持 SILK），支持配置直传格式跳过转换
                        const uploadFormats = account.config?.audioFormatPolicy?.uploadDirectFormats ?? account.config?.voiceDirectUploadFormats;
                        const silkBase64 = await audioFileToSilkBase64(voicePath, uploadFormats);
                        if (!silkBase64) {
                          const ext = path.extname(voicePath).toLowerCase();
                          log?.error(`[qqbot:${account.accountId}] Voice conversion to SILK failed: ${ext} (${fileSize} bytes). Check [audio-convert] logs for details.`);
                          await sendErrorMessage(`语音格式转换失败，请稍后重试`);
                          continue;
                        }
                        log?.info(`[qqbot:${account.accountId}] Voice file converted to SILK Base64 (${fileSize} bytes)`);

                        await sendWithTokenRetry(async (token) => {
                          if (event.type === "c2c") {
                            await sendC2CVoiceMessage(token, event.senderId, silkBase64!, event.messageId);
                          } else if (event.type === "group" && event.groupOpenid) {
                            await sendGroupVoiceMessage(token, event.groupOpenid, silkBase64!, event.messageId);
                          } else if (event.channelId) {
                            await sendChannelMessage(token, event.channelId, `[语音消息暂不支持频道发送]`, event.messageId);
                          }
                        });
                        log?.info(`[qqbot:${account.accountId}] Sent voice via <qqvoice> tag: ${voicePath.slice(0, 60)}...`);
                      } catch (err) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send voice from <qqvoice>: ${err}`);
                        await sendErrorMessage(formatMediaErrorMessage("语音", err));
                      }
                    } else if (item.type === "video") {
                      // 发送视频（支持公网 URL 和本地文件，展开 ~ 路径）
                      const videoPath = normalizePath(item.content);
                      try {
                        const isHttpUrl = videoPath.startsWith("http://") || videoPath.startsWith("https://");

                        // 本地视频大文件进度提示
                        if (!isHttpUrl) {
                          const vidCheck = checkFileSize(videoPath);
                          if (vidCheck.ok && isLargeFile(vidCheck.size)) {
                            try {
                              await sendWithTokenRetry(async (token) => {
                                const hint = `⏳ 正在上传视频 (${formatFileSize(vidCheck.size)})...`;
                                if (event.type === "c2c") {
                                  await sendC2CMessage(token, event.senderId, hint, event.messageId);
                                } else if (event.type === "group" && event.groupOpenid) {
                                  await sendGroupMessage(token, event.groupOpenid, hint, event.messageId);
                                }
                              });
                            } catch {}
                          }
                        }

                        await sendWithTokenRetry(async (token) => {
                          if (isHttpUrl) {
                            // 公网 URL
                            if (event.type === "c2c") {
                              await sendC2CVideoMessage(token, event.senderId, videoPath, undefined, event.messageId);
                            } else if (event.type === "group" && event.groupOpenid) {
                              await sendGroupVideoMessage(token, event.groupOpenid, videoPath, undefined, event.messageId);
                            } else if (event.channelId) {
                              await sendChannelMessage(token, event.channelId, `[视频消息暂不支持频道发送]`, event.messageId);
                            }
                          } else {
                            // 本地文件：读取为 Base64
                            if (!(await fileExistsAsync(videoPath))) {
                              throw new Error(`视频文件不存在: ${videoPath}`);
                            }
                            // 文件大小校验
                            const vidSizeCheck = checkFileSize(videoPath);
                            if (!vidSizeCheck.ok) {
                              throw new Error(vidSizeCheck.error!);
                            }
                            const fileBuffer = await readFileAsync(videoPath);
                            const videoBase64 = fileBuffer.toString("base64");
                            log?.info(`[qqbot:${account.accountId}] Read local video (${formatFileSize(fileBuffer.length)}): ${videoPath}`);

                            if (event.type === "c2c") {
                              await sendC2CVideoMessage(token, event.senderId, undefined, videoBase64, event.messageId);
                            } else if (event.type === "group" && event.groupOpenid) {
                              await sendGroupVideoMessage(token, event.groupOpenid, undefined, videoBase64, event.messageId);
                            } else if (event.channelId) {
                              await sendChannelMessage(token, event.channelId, `[视频消息暂不支持频道发送]`, event.messageId);
                            }
                          }
                        });
                        log?.info(`[qqbot:${account.accountId}] Sent video via <qqvideo> tag: ${videoPath.slice(0, 60)}...`);
                      } catch (err) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send video from <qqvideo>: ${err}`);
                        await sendErrorMessage(formatMediaErrorMessage("视频", err));
                      }
                    } else if (item.type === "file") {
                      // 发送文件（展开 ~ 路径）
                      const filePath = normalizePath(item.content);
                      try {
                        const isHttpUrl = filePath.startsWith("http://") || filePath.startsWith("https://");
                        const fileName = sanitizeFileName(path.basename(filePath));

                        // 本地文件大文件进度提示
                        if (!isHttpUrl) {
                          const fileCheck = checkFileSize(filePath);
                          if (fileCheck.ok && isLargeFile(fileCheck.size)) {
                            try {
                              await sendWithTokenRetry(async (token) => {
                                const hint = `⏳ 正在上传文件 ${fileName} (${formatFileSize(fileCheck.size)})...`;
                                if (event.type === "c2c") {
                                  await sendC2CMessage(token, event.senderId, hint, event.messageId);
                                } else if (event.type === "group" && event.groupOpenid) {
                                  await sendGroupMessage(token, event.groupOpenid, hint, event.messageId);
                                }
                              });
                            } catch {}
                          }
                        }

                        await sendWithTokenRetry(async (token) => {
                          if (isHttpUrl) {
                            // 公网 URL
                            if (event.type === "c2c") {
                              await sendC2CFileMessage(token, event.senderId, undefined, filePath, event.messageId, fileName);
                            } else if (event.type === "group" && event.groupOpenid) {
                              await sendGroupFileMessage(token, event.groupOpenid, undefined, filePath, event.messageId, fileName);
                            } else if (event.channelId) {
                              await sendChannelMessage(token, event.channelId, `[文件消息暂不支持频道发送]`, event.messageId);
                            }
                          } else {
                            // 本地文件
                            if (!(await fileExistsAsync(filePath))) {
                              throw new Error(`文件不存在: ${filePath}`);
                            }
                            // 文件大小校验
                            const flSizeCheck = checkFileSize(filePath);
                            if (!flSizeCheck.ok) {
                              throw new Error(flSizeCheck.error!);
                            }
                            const fileBuffer = await readFileAsync(filePath);
                            const fileBase64 = fileBuffer.toString("base64");
                            log?.info(`[qqbot:${account.accountId}] Read local file (${formatFileSize(fileBuffer.length)}): ${filePath}`);

                            if (event.type === "c2c") {
                              await sendC2CFileMessage(token, event.senderId, fileBase64, undefined, event.messageId, fileName);
                            } else if (event.type === "group" && event.groupOpenid) {
                              await sendGroupFileMessage(token, event.groupOpenid, fileBase64, undefined, event.messageId, fileName);
                            } else if (event.channelId) {
                              await sendChannelMessage(token, event.channelId, `[文件消息暂不支持频道发送]`, event.messageId);
                            }
                          }
                        });
                        log?.info(`[qqbot:${account.accountId}] Sent file via <qqfile> tag: ${filePath.slice(0, 60)}...`);
                      } catch (err) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send file from <qqfile>: ${err}`);
                        await sendErrorMessage(`文件发送失败: ${err}`);
                      }
                    }
                  }
                  
                  // 记录活动并返回
                  pluginRuntime.channel.activity.record({
                    channel: "qqbot",
                    accountId: account.accountId,
                    direction: "outbound",
                  });
                  return;
                }
                
                // ============ 结构化载荷检测与分发 ============
                // 优先检测 QQBOT_PAYLOAD: 前缀，如果是结构化载荷则分发到对应处理器
                const payloadResult = parseQQBotPayload(replyText);
                
                if (payloadResult.isPayload) {
                  if (payloadResult.error) {
                    // 载荷解析失败，发送错误提示
                    log?.error(`[qqbot:${account.accountId}] Payload parse error: ${payloadResult.error}`);
                    await sendErrorMessage(`[QQBot] 载荷解析失败: ${payloadResult.error}`);
                    return;
                  }
                  
                  if (payloadResult.payload) {
                    const parsedPayload = payloadResult.payload;
                    log?.info(`[qqbot:${account.accountId}] Detected structured payload, type: ${parsedPayload.type}`);
                    
                    // 根据 type 分发到对应处理器
                    if (isCronReminderPayload(parsedPayload)) {
                      // ============ 定时提醒载荷处理 ============
                      log?.info(`[qqbot:${account.accountId}] Processing cron_reminder payload`);
                      
                      // 将载荷编码为 Base64，构建 cron add 命令
                      const cronMessage = encodePayloadForCron(parsedPayload);
                      
                      // 向用户确认提醒已设置（通过正常消息发送）
                      const confirmText = `⏰ 提醒已设置，将在指定时间发送: "${parsedPayload.content}"`;
                      try {
                        await sendWithTokenRetry(async (token) => {
                          if (event.type === "c2c") {
                            await sendC2CMessage(token, event.senderId, confirmText, event.messageId);
                          } else if (event.type === "group" && event.groupOpenid) {
                            await sendGroupMessage(token, event.groupOpenid, confirmText, event.messageId);
                          } else if (event.channelId) {
                            await sendChannelMessage(token, event.channelId, confirmText, event.messageId);
                          }
                        });
                        log?.info(`[qqbot:${account.accountId}] Cron reminder confirmation sent, cronMessage: ${cronMessage}`);
                      } catch (err) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send cron confirmation: ${err}`);
                      }
                      
                      // 记录活动并返回（cron add 命令需要由 AI 执行，这里只处理载荷）
                      pluginRuntime.channel.activity.record({
                        channel: "qqbot",
                        accountId: account.accountId,
                        direction: "outbound",
                      });
                      return;
                    } else if (isMediaPayload(parsedPayload)) {
                      // ============ 媒体消息载荷处理 ============
                      log?.info(`[qqbot:${account.accountId}] Processing media payload, mediaType: ${parsedPayload.mediaType}`);
                      
                      if (parsedPayload.mediaType === "image") {
                        // 处理图片发送（展开 ~ 路径）
                        let imageUrl = normalizePath(parsedPayload.path);
                        
                        // 如果是本地文件，转换为 Base64 Data URL
                        if (parsedPayload.source === "file") {
                          try {
                            if (!(await fileExistsAsync(imageUrl))) {
                              await sendErrorMessage(`[QQBot] 图片文件不存在: ${imageUrl}`);
                              return;
                            }
                            const imgSzCheck = checkFileSize(imageUrl);
                            if (!imgSzCheck.ok) {
                              await sendErrorMessage(`[QQBot] ${imgSzCheck.error}`);
                              return;
                            }
                            const fileBuffer = await readFileAsync(imageUrl);
                            const base64Data = fileBuffer.toString("base64");
                            const ext = path.extname(imageUrl).toLowerCase();
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
                              await sendErrorMessage(`[QQBot] 不支持的图片格式: ${ext}`);
                              return;
                            }
                            imageUrl = `data:${mimeType};base64,${base64Data}`;
                            log?.info(`[qqbot:${account.accountId}] Converted local image to Base64 (size: ${formatFileSize(fileBuffer.length)})`);
                          } catch (readErr) {
                            log?.error(`[qqbot:${account.accountId}] Failed to read local image: ${readErr}`);
                            await sendErrorMessage(`[QQBot] 读取图片文件失败: ${readErr}`);
                            return;
                          }
                        }
                        
                        // 发送图片
                        try {
                          await sendWithTokenRetry(async (token) => {
                            if (event.type === "c2c") {
                              await sendC2CImageMessage(token, event.senderId, imageUrl, event.messageId);
                            } else if (event.type === "group" && event.groupOpenid) {
                              await sendGroupImageMessage(token, event.groupOpenid, imageUrl, event.messageId);
                            } else if (event.channelId) {
                              // 频道使用 Markdown 格式
                              await sendChannelMessage(token, event.channelId, `![](${parsedPayload.path})`, event.messageId);
                            }
                          });
                          log?.info(`[qqbot:${account.accountId}] Sent image via media payload`);
                          
                          // 如果有描述文本，单独发送
                          if (parsedPayload.caption) {
                            await sendWithTokenRetry(async (token) => {
                              if (event.type === "c2c") {
                                await sendC2CMessage(token, event.senderId, parsedPayload.caption!, event.messageId);
                              } else if (event.type === "group" && event.groupOpenid) {
                                await sendGroupMessage(token, event.groupOpenid, parsedPayload.caption!, event.messageId);
                              } else if (event.channelId) {
                                await sendChannelMessage(token, event.channelId, parsedPayload.caption!, event.messageId);
                              }
                            });
                          }
                        } catch (err) {
                          log?.error(`[qqbot:${account.accountId}] Failed to send image: ${err}`);
                          await sendErrorMessage(formatMediaErrorMessage("图片", err));
                        }
                      } else if (parsedPayload.mediaType === "audio") {
                        // TTS 语音发送：文字 → PCM → SILK → QQ 语音
                        try {
                          const ttsText = parsedPayload.caption || parsedPayload.path;
                          if (!ttsText?.trim()) {
                            await sendErrorMessage(`[QQBot] 语音消息缺少文本内容`);
                          } else {
                            const ttsCfg = resolveTTSConfig(cfg as Record<string, unknown>);
                            if (!ttsCfg) {
                              log?.error(`[qqbot:${account.accountId}] TTS not configured (channels.qqbot.tts in openclaw.json)`);
                              await sendErrorMessage(`[QQBot] TTS 未配置，请在 openclaw.json 的 channels.qqbot.tts 中配置`);
                            } else {
                              log?.info(`[qqbot:${account.accountId}] TTS: "${ttsText.slice(0, 50)}..." via ${ttsCfg.model}`);
                              const ttsDir = getQQBotDataDir("tts");
                              const { silkBase64, duration } = await textToSilk(ttsText, ttsCfg, ttsDir);
                              log?.info(`[qqbot:${account.accountId}] TTS done: ${formatDuration(duration)}, uploading voice...`);

                              await sendWithTokenRetry(async (token) => {
                                if (event.type === "c2c") {
                                  await sendC2CVoiceMessage(token, event.senderId, silkBase64, event.messageId);
                                } else if (event.type === "group" && event.groupOpenid) {
                                  await sendGroupVoiceMessage(token, event.groupOpenid, silkBase64, event.messageId);
                                } else if (event.channelId) {
                                  await sendChannelMessage(token, event.channelId, `[语音消息暂不支持频道发送] ${ttsText}`, event.messageId);
                                }
                              });
                              log?.info(`[qqbot:${account.accountId}] Voice message sent`);
                            }
                          }
                        } catch (err) {
                          log?.error(`[qqbot:${account.accountId}] TTS/voice send failed: ${err}`);
                          await sendErrorMessage(`[QQBot] 语音发送失败: ${err}`);
                        }
                      } else if (parsedPayload.mediaType === "video") {
                        // 视频发送：支持公网 URL 和本地文件
                        try {
                          const videoPath = normalizePath(parsedPayload.path ?? "");
                          if (!videoPath?.trim()) {
                            await sendErrorMessage(`[QQBot] 视频消息缺少视频路径`);
                          } else {
                            const isHttpUrl = videoPath.startsWith("http://") || videoPath.startsWith("https://");
                            log?.info(`[qqbot:${account.accountId}] Video send: "${videoPath.slice(0, 60)}..."`);

                            await sendWithTokenRetry(async (token) => {
                              if (isHttpUrl) {
                                // 公网 URL
                                if (event.type === "c2c") {
                                  await sendC2CVideoMessage(token, event.senderId, videoPath, undefined, event.messageId);
                                } else if (event.type === "group" && event.groupOpenid) {
                                  await sendGroupVideoMessage(token, event.groupOpenid, videoPath, undefined, event.messageId);
                                } else if (event.channelId) {
                                  await sendChannelMessage(token, event.channelId, `[视频消息暂不支持频道发送]`, event.messageId);
                                }
                              } else {
                                // 本地文件：读取为 Base64
                                if (!(await fileExistsAsync(videoPath))) {
                                  throw new Error(`视频文件不存在: ${videoPath}`);
                                }
                                const vPaySzCheck = checkFileSize(videoPath);
                                if (!vPaySzCheck.ok) {
                                  throw new Error(vPaySzCheck.error!);
                                }
                                const fileBuffer = await readFileAsync(videoPath);
                                const videoBase64 = fileBuffer.toString("base64");
                                log?.info(`[qqbot:${account.accountId}] Read local video (${formatFileSize(fileBuffer.length)}): ${videoPath}`);

                                if (event.type === "c2c") {
                                  await sendC2CVideoMessage(token, event.senderId, undefined, videoBase64, event.messageId);
                                } else if (event.type === "group" && event.groupOpenid) {
                                  await sendGroupVideoMessage(token, event.groupOpenid, undefined, videoBase64, event.messageId);
                                } else if (event.channelId) {
                                  await sendChannelMessage(token, event.channelId, `[视频消息暂不支持频道发送]`, event.messageId);
                                }
                              }
                            });
                            log?.info(`[qqbot:${account.accountId}] Video message sent`);

                            // 如果有描述文本，单独发送
                            if (parsedPayload.caption) {
                              await sendWithTokenRetry(async (token) => {
                                if (event.type === "c2c") {
                                  await sendC2CMessage(token, event.senderId, parsedPayload.caption!, event.messageId);
                                } else if (event.type === "group" && event.groupOpenid) {
                                  await sendGroupMessage(token, event.groupOpenid, parsedPayload.caption!, event.messageId);
                                } else if (event.channelId) {
                                  await sendChannelMessage(token, event.channelId, parsedPayload.caption!, event.messageId);
                                }
                              });
                            }
                          }
                        } catch (err) {
                          log?.error(`[qqbot:${account.accountId}] Video send failed: ${err}`);
                          await sendErrorMessage(formatMediaErrorMessage("视频", err));
                        }
                      } else if (parsedPayload.mediaType === "file") {
                        // 文件发送
                        try {
                          const filePath = normalizePath(parsedPayload.path ?? "");
                          if (!filePath?.trim()) {
                            await sendErrorMessage(`[QQBot] 文件消息缺少文件路径`);
                          } else {
                            const isHttpUrl = filePath.startsWith("http://") || filePath.startsWith("https://");
                            const fileName = sanitizeFileName(path.basename(filePath));
                            log?.info(`[qqbot:${account.accountId}] File send: "${filePath.slice(0, 60)}..." (${isHttpUrl ? "URL" : "local"})`);

                            await sendWithTokenRetry(async (token) => {
                              if (isHttpUrl) {
                                if (event.type === "c2c") {
                                  await sendC2CFileMessage(token, event.senderId, undefined, filePath, event.messageId, fileName);
                                } else if (event.type === "group" && event.groupOpenid) {
                                  await sendGroupFileMessage(token, event.groupOpenid, undefined, filePath, event.messageId, fileName);
                                } else if (event.channelId) {
                                  await sendChannelMessage(token, event.channelId, `[文件消息暂不支持频道发送]`, event.messageId);
                                }
                              } else {
                                if (!(await fileExistsAsync(filePath))) {
                                  throw new Error(`文件不存在: ${filePath}`);
                                }
                                const fPaySzCheck = checkFileSize(filePath);
                                if (!fPaySzCheck.ok) {
                                  throw new Error(fPaySzCheck.error!);
                                }
                                const fileBuffer = await readFileAsync(filePath);
                                const fileBase64 = fileBuffer.toString("base64");
                                if (event.type === "c2c") {
                                  await sendC2CFileMessage(token, event.senderId, fileBase64, undefined, event.messageId, fileName);
                                } else if (event.type === "group" && event.groupOpenid) {
                                  await sendGroupFileMessage(token, event.groupOpenid, fileBase64, undefined, event.messageId, fileName);
                                } else if (event.channelId) {
                                  await sendChannelMessage(token, event.channelId, `[文件消息暂不支持频道发送]`, event.messageId);
                                }
                              }
                            });
                            log?.info(`[qqbot:${account.accountId}] File message sent`);
                          }
                        } catch (err) {
                          log?.error(`[qqbot:${account.accountId}] File send failed: ${err}`);
                          await sendErrorMessage(formatMediaErrorMessage("文件", err));
                        }
                      } else {
                        log?.error(`[qqbot:${account.accountId}] Unknown media type: ${(parsedPayload as MediaPayload).mediaType}`);
                        await sendErrorMessage(`[QQBot] 不支持的媒体类型: ${(parsedPayload as MediaPayload).mediaType}`);
                      }
                      
                      // 记录活动并返回
                      pluginRuntime.channel.activity.record({
                        channel: "qqbot",
                        accountId: account.accountId,
                        direction: "outbound",
                      });
                      return;
                    } else {
                      // 未知的载荷类型
                      log?.error(`[qqbot:${account.accountId}] Unknown payload type: ${(parsedPayload as any).type}`);
                      await sendErrorMessage(`[QQBot] 不支持的载荷类型: ${(parsedPayload as any).type}`);
                      return;
                    }
                  }
                }
                
                // ============ 非结构化消息：简化处理 ============
                // 📝 设计原则：JSON payload (QQBOT_PAYLOAD) 是发送本地图片的唯一方式
                // 非结构化消息只处理：公网 URL (http/https) 和 Base64 Data URL
                const imageUrls: string[] = [];
                
                /**
                 * 检查并收集图片 URL（仅支持公网 URL 和 Base64 Data URL）
                 * ⚠️ 本地文件路径必须使用 QQBOT_PAYLOAD JSON 格式发送
                 */
                const collectImageUrl = (url: string | undefined | null): boolean => {
                  if (!url) return false;
                  
                  const isHttpUrl = url.startsWith("http://") || url.startsWith("https://");
                  const isDataUrl = url.startsWith("data:image/");
                  
                  if (isHttpUrl || isDataUrl) {
                    if (!imageUrls.includes(url)) {
                      imageUrls.push(url);
                      if (isDataUrl) {
                        log?.info(`[qqbot:${account.accountId}] Collected Base64 image (length: ${url.length})`);
                      } else {
                        log?.info(`[qqbot:${account.accountId}] Collected media URL: ${url.slice(0, 80)}...`);
                      }
                    }
                    return true;
                  }
                  
                  // ⚠️ 本地文件路径不再在此处处理，应使用对应的 <qqXXX> 标签
                  if (isLocalFilePath(url)) {
                    const ext = path.extname(url).toLowerCase();
                    const VIDEO_EXTS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"];
                    let suggestedTag = "qqimg";
                    let mediaDesc = "图片";
                    if (isAudioFile(url)) {
                      suggestedTag = "qqvoice";
                      mediaDesc = "语音";
                    } else if (VIDEO_EXTS.includes(ext)) {
                      suggestedTag = "qqvideo";
                      mediaDesc = "视频";
                    } else if (![".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
                      suggestedTag = "qqfile";
                      mediaDesc = "文件";
                    }
                    log?.info(`[qqbot:${account.accountId}] 💡 Local path detected in non-structured message (not sending): ${url}`);
                    log?.info(`[qqbot:${account.accountId}] 💡 Hint: Use <${suggestedTag}>${url}</${suggestedTag}> tag to send local ${mediaDesc}`);
                  }
                  return false;
                };
                
                // 处理 mediaUrls 和 mediaUrl 字段
                if (payload.mediaUrls?.length) {
                  for (const url of payload.mediaUrls) {
                    collectImageUrl(url);
                  }
                }
                if (payload.mediaUrl) {
                  collectImageUrl(payload.mediaUrl);
                }
                
                // 提取文本中的图片格式（仅处理公网 URL）
                // 📝 设计：本地路径必须使用 QQBOT_PAYLOAD JSON 格式发送
                const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/gi;
                const mdMatches = [...replyText.matchAll(mdImageRegex)];
                for (const match of mdMatches) {
                  const url = match[2]?.trim();
                  if (url && !imageUrls.includes(url)) {
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                      // 公网 URL：收集并处理
                      imageUrls.push(url);
                      log?.info(`[qqbot:${account.accountId}] Extracted HTTP image from markdown: ${url.slice(0, 80)}...`);
                    } else if (looksLikeLocalPath(url)) {
                      // 本地路径：根据文件类型给出正确的标签提示
                      const ext = path.extname(url).toLowerCase();
                      const VIDEO_EXTS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv"];
                      let suggestedTag = "qqimg";
                      let mediaDesc = "图片";
                      if (isAudioFile(url)) {
                        suggestedTag = "qqvoice";
                        mediaDesc = "语音";
                      } else if (VIDEO_EXTS.includes(ext)) {
                        suggestedTag = "qqvideo";
                        mediaDesc = "视频";
                      } else if (![".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
                        suggestedTag = "qqfile";
                        mediaDesc = "文件";
                      }
                      log?.info(`[qqbot:${account.accountId}] 💡 Local path detected in non-structured message (not sending): ${url}`);
                      log?.info(`[qqbot:${account.accountId}] 💡 Hint: Use <${suggestedTag}>${url}</${suggestedTag}> tag to send local ${mediaDesc}`);
                    }
                  }
                }
                
                // 提取裸 URL 图片（公网 URL）
                const bareUrlRegex = /(?<![(\["'])(https?:\/\/[^\s)"'<>]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s"'<>]*)?)/gi;
                const bareUrlMatches = [...replyText.matchAll(bareUrlRegex)];
                for (const match of bareUrlMatches) {
                  const url = match[1];
                  if (url && !imageUrls.includes(url)) {
                    imageUrls.push(url);
                    log?.info(`[qqbot:${account.accountId}] Extracted bare image URL: ${url.slice(0, 80)}...`);
                  }
                }
                
                // 判断是否使用 markdown 模式
                const useMarkdown = account.markdownSupport === true;
                log?.info(`[qqbot:${account.accountId}] Markdown mode: ${useMarkdown}, images: ${imageUrls.length}`);
                
                let textWithoutImages = replyText;
                
                // 🎯 过滤内部标记（如 [[reply_to: xxx]]）
                // 这些标记可能被 AI 错误地学习并输出
                textWithoutImages = filterInternalMarkers(textWithoutImages);
                
                // 根据模式处理图片
                if (useMarkdown) {
                  // ============ Markdown 模式 ============
                  // 🎯 关键改动：区分公网 URL 和本地文件/Base64
                  // - 公网 URL (http/https) → 使用 Markdown 图片格式 ![#宽px #高px](url)
                  // - 本地文件/Base64 (data:image/...) → 使用富媒体 API 发送
                  
                  // 分离图片：公网 URL vs Base64/本地文件
                  const httpImageUrls: string[] = [];      // 公网 URL，用于 Markdown 嵌入
                  const base64ImageUrls: string[] = [];    // Base64，用于富媒体 API
                  
                  for (const url of imageUrls) {
                    if (url.startsWith("data:image/")) {
                      base64ImageUrls.push(url);
                    } else if (url.startsWith("http://") || url.startsWith("https://")) {
                      httpImageUrls.push(url);
                    }
                  }
                  
                  log?.info(`[qqbot:${account.accountId}] Image classification: httpUrls=${httpImageUrls.length}, base64=${base64ImageUrls.length}`);
                  
                  // 🔹 第一步：通过富媒体 API 发送 Base64 图片（本地文件已转换为 Base64）
                  if (base64ImageUrls.length > 0) {
                    log?.info(`[qqbot:${account.accountId}] Sending ${base64ImageUrls.length} image(s) via Rich Media API...`);
                    for (const imageUrl of base64ImageUrls) {
                      try {
                        await sendWithTokenRetry(async (token) => {
                          if (event.type === "c2c") {
                            await sendC2CImageMessage(token, event.senderId, imageUrl, event.messageId);
                          } else if (event.type === "group" && event.groupOpenid) {
                            await sendGroupImageMessage(token, event.groupOpenid, imageUrl, event.messageId);
                          } else if (event.channelId) {
                            // 频道暂不支持富媒体，跳过
                            log?.info(`[qqbot:${account.accountId}] Channel does not support rich media, skipping Base64 image`);
                          }
                        });
                        log?.info(`[qqbot:${account.accountId}] Sent Base64 image via Rich Media API (size: ${imageUrl.length} chars)`);
                      } catch (imgErr) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send Base64 image via Rich Media API: ${imgErr}`);
                      }
                    }
                  }
                  
                  // 🔹 第二步：处理文本和公网 URL 图片
                  // 记录已存在于文本中的 markdown 图片 URL
                  const existingMdUrls = new Set(mdMatches.map(m => m[2]));
                  
                  // 需要追加的公网图片（从 mediaUrl/mediaUrls 来的，且不在文本中）
                  const imagesToAppend: string[] = [];
                  
                  // 处理需要追加的公网 URL 图片：获取尺寸并格式化
                  for (const url of httpImageUrls) {
                    if (!existingMdUrls.has(url)) {
                      // 这个 URL 不在文本的 markdown 格式中，需要追加
                      try {
                        const size = await getImageSize(url);
                        const mdImage = formatQQBotMarkdownImage(url, size);
                        imagesToAppend.push(mdImage);
                        log?.info(`[qqbot:${account.accountId}] Formatted HTTP image: ${size ? `${size.width}x${size.height}` : 'default size'} - ${url.slice(0, 60)}...`);
                      } catch (err) {
                        log?.info(`[qqbot:${account.accountId}] Failed to get image size, using default: ${err}`);
                        const mdImage = formatQQBotMarkdownImage(url, null);
                        imagesToAppend.push(mdImage);
                      }
                    }
                  }
                  
                  // 处理文本中已有的 markdown 图片：补充公网 URL 的尺寸信息
                  // 📝 本地路径不再特殊处理（保留在文本中），因为不通过非结构化消息发送
                  for (const match of mdMatches) {
                    const fullMatch = match[0];  // ![alt](url)
                    const imgUrl = match[2];      // url 部分
                    
                    // 只处理公网 URL，补充尺寸信息
                    const isHttpUrl = imgUrl.startsWith('http://') || imgUrl.startsWith('https://');
                    if (isHttpUrl && !hasQQBotImageSize(fullMatch)) {
                      try {
                        const size = await getImageSize(imgUrl);
                        const newMdImage = formatQQBotMarkdownImage(imgUrl, size);
                        textWithoutImages = textWithoutImages.replace(fullMatch, newMdImage);
                        log?.info(`[qqbot:${account.accountId}] Updated image with size: ${size ? `${size.width}x${size.height}` : 'default'} - ${imgUrl.slice(0, 60)}...`);
                      } catch (err) {
                        log?.info(`[qqbot:${account.accountId}] Failed to get image size for existing md, using default: ${err}`);
                        const newMdImage = formatQQBotMarkdownImage(imgUrl, null);
                        textWithoutImages = textWithoutImages.replace(fullMatch, newMdImage);
                      }
                    }
                  }
                  
                  // 从文本中移除裸 URL 图片（已转换为 markdown 格式）
                  for (const match of bareUrlMatches) {
                    textWithoutImages = textWithoutImages.replace(match[0], "").trim();
                  }
                  
                  // 追加需要添加的公网图片到文本末尾
                  if (imagesToAppend.length > 0) {
                    textWithoutImages = textWithoutImages.trim();
                    if (textWithoutImages) {
                      textWithoutImages += "\n\n" + imagesToAppend.join("\n");
                    } else {
                      textWithoutImages = imagesToAppend.join("\n");
                    }
                  }
                  
                  // 🔹 第三步：发送带公网图片的 markdown 消息
                  if (textWithoutImages.trim()) {
                    try {
                      await sendWithTokenRetry(async (token) => {
                        const ref = consumeQuoteRef();
                        if (event.type === "c2c") {
                          await sendC2CMessage(token, event.senderId, textWithoutImages, event.messageId, ref);
                        } else if (event.type === "group" && event.groupOpenid) {
                          await sendGroupMessage(token, event.groupOpenid, textWithoutImages, event.messageId, ref);
                        } else if (event.channelId) {
                          await sendChannelMessage(token, event.channelId, textWithoutImages, event.messageId, ref);
                        }
                      });
                      log?.info(`[qqbot:${account.accountId}] Sent markdown message with ${httpImageUrls.length} HTTP images (${event.type})`);
                    } catch (err) {
                      log?.error(`[qqbot:${account.accountId}] Failed to send markdown message: ${err}`);
                    }
                  }
                } else {
                  // ============ 普通文本模式：使用富媒体 API 发送图片 ============
                  // 从文本中移除所有图片相关内容
                  for (const match of mdMatches) {
                    textWithoutImages = textWithoutImages.replace(match[0], "").trim();
                  }
                  for (const match of bareUrlMatches) {
                    textWithoutImages = textWithoutImages.replace(match[0], "").trim();
                  }
                  
                  // 处理文本中的 URL 点号（防止被 QQ 解析为链接），仅群聊时过滤，C2C 不过滤
                  if (textWithoutImages && event.type !== "c2c") {
                    textWithoutImages = textWithoutImages.replace(/([a-zA-Z0-9])\.([a-zA-Z0-9])/g, "$1_$2");
                  }
                  
                  try {
                    // 发送图片（通过富媒体 API）
                    for (const imageUrl of imageUrls) {
                      try {
                        await sendWithTokenRetry(async (token) => {
                          if (event.type === "c2c") {
                            await sendC2CImageMessage(token, event.senderId, imageUrl, event.messageId);
                          } else if (event.type === "group" && event.groupOpenid) {
                            await sendGroupImageMessage(token, event.groupOpenid, imageUrl, event.messageId);
                          } else if (event.channelId) {
                            // 频道暂不支持富媒体，发送文本 URL
                            await sendChannelMessage(token, event.channelId, imageUrl, event.messageId);
                          }
                        });
                        log?.info(`[qqbot:${account.accountId}] Sent image via media API: ${imageUrl.slice(0, 80)}...`);
                      } catch (imgErr) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send image: ${imgErr}`);
                      }
                    }

                    // 发送文本消息
                    if (textWithoutImages.trim()) {
                      await sendWithTokenRetry(async (token) => {
                        const ref = consumeQuoteRef();
                        if (event.type === "c2c") {
                          await sendC2CMessage(token, event.senderId, textWithoutImages, event.messageId, ref);
                        } else if (event.type === "group" && event.groupOpenid) {
                          await sendGroupMessage(token, event.groupOpenid, textWithoutImages, event.messageId, ref);
                        } else if (event.channelId) {
                          await sendChannelMessage(token, event.channelId, textWithoutImages, event.messageId, ref);
                        }
                      });
                      log?.info(`[qqbot:${account.accountId}] Sent text reply (${event.type})`);
                    }
                  } catch (err) {
                    log?.error(`[qqbot:${account.accountId}] Send failed: ${err}`);
                  }
                }

                pluginRuntime.channel.activity.record({
                  channel: "qqbot",
                  accountId: account.accountId,
                  direction: "outbound",
                });
              },
              onError: async (err: unknown) => {
                log?.error(`[qqbot:${account.accountId}] Dispatch error: ${err}`);
                hasResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }
                
                // 发送错误提示给用户，显示完整错误信息
                const errMsg = String(err);
                if (errMsg.includes("401") || errMsg.includes("key") || errMsg.includes("auth")) {
                  await sendErrorMessage("⚠️ AI 服务认证失败，API Key 可能无效，请联系管理员检查配置。");
                } else {
                  await sendErrorMessage(`⚠️ AI 处理出错: ${errMsg.slice(0, 500)}`);
                }
              },
            },
            replyOptions: {
              disableBlockStreaming: false,
            },
          });

          // 等待分发完成或超时
          try {
            await Promise.race([dispatchPromise, timeoutPromise]);
          } catch (err) {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            if (!hasResponse) {
              log?.error(`[qqbot:${account.accountId}] No response within timeout`);
              await sendErrorMessage("⏳ 已收到，正在处理中…");
            }
          } finally {
            // 清理 tool-only 兜底定时器
            if (toolOnlyTimeoutId) {
              clearTimeout(toolOnlyTimeoutId);
              toolOnlyTimeoutId = null;
            }
            // dispatch 完成后，如果只有 tool 没有 block，且尚未发过兜底，立即兜底
            if (toolDeliverCount > 0 && !hasBlockResponse && !toolFallbackSent) {
              toolFallbackSent = true;
              log?.error(`[qqbot:${account.accountId}] Dispatch completed with ${toolDeliverCount} tool deliver(s) but no block deliver, sending fallback`);
              const fallback = formatToolFallback();
              await sendErrorMessage(fallback);
            }
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message processing failed: ${err}`);
          await sendErrorMessage(`⚠️ 消息处理失败: ${String(err).slice(0, 500)}`);
        }
      };

      ws.on("open", () => {
        log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
        isConnecting = false; // 连接完成，释放锁
        reconnectAttempts = 0; // 连接成功，重置重试计数
        lastConnectTime = Date.now(); // 记录连接时间
        // 启动消息处理器（异步处理，防止阻塞心跳）
        startMessageProcessor(handleMessage);
        // P1-1: 启动后台 Token 刷新
        startBackgroundTokenRefresh(account.appId, account.clientSecret, {
          log: log as { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void },
        });
      });

      ws.on("message", async (data) => {
        try {
          const rawData = data.toString();
          const payload = JSON.parse(rawData) as WSPayload;
          const { op, d, s, t } = payload;

          if (s) {
            lastSeq = s;
            // P1-2: 更新持久化存储中的 lastSeq（节流保存）
            if (sessionId) {
              saveSession({
                sessionId,
                lastSeq,
                lastConnectedAt: lastConnectTime,
                intentLevelIndex: lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex,
                accountId: account.accountId,
                savedAt: Date.now(),
                appId: account.appId,
              });
            }
          }

          log?.debug?.(`[qqbot:${account.accountId}] Received op=${op} t=${t}`);

          switch (op) {
            case 10: // Hello
              log?.info(`[qqbot:${account.accountId}] Hello received`);
              
              // 如果有 session_id，尝试 Resume
              if (sessionId && lastSeq !== null) {
                log?.info(`[qqbot:${account.accountId}] Attempting to resume session ${sessionId}`);
                ws.send(JSON.stringify({
                  op: 6, // Resume
                  d: {
                    token: `QQBot ${accessToken}`,
                    session_id: sessionId,
                    seq: lastSeq,
                  },
                }));
              } else {
                // 新连接，发送 Identify
                // 如果有上次成功的级别，直接使用；否则从当前级别开始尝试
                const levelToUse = lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex;
                const intentLevel = INTENT_LEVELS[Math.min(levelToUse, INTENT_LEVELS.length - 1)];
                log?.info(`[qqbot:${account.accountId}] Sending identify with intents: ${intentLevel.intents} (${intentLevel.description})`);
                ws.send(JSON.stringify({
                  op: 2,
                  d: {
                    token: `QQBot ${accessToken}`,
                    intents: intentLevel.intents,
                    shard: [0, 1],
                  },
                }));
              }

              // 启动心跳
              const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
              if (heartbeatInterval) clearInterval(heartbeatInterval);
              heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ op: 1, d: lastSeq }));
                  log?.debug?.(`[qqbot:${account.accountId}] Heartbeat sent`);
                }
              }, interval);
              break;

            case 0: // Dispatch
              if (t === "READY") {
                const readyData = d as { session_id: string };
                sessionId = readyData.session_id;
                // 记录成功的权限级别
                lastSuccessfulIntentLevel = intentLevelIndex;
                const successLevel = INTENT_LEVELS[intentLevelIndex];
                log?.info(`[qqbot:${account.accountId}] Ready with ${successLevel.description}, session: ${sessionId}`);
                // P1-2: 保存新的 Session 状态
                saveSession({
                  sessionId,
                  lastSeq,
                  lastConnectedAt: Date.now(),
                  intentLevelIndex,
                  accountId: account.accountId,
                  savedAt: Date.now(),
                  appId: account.appId,
                });
                onReady?.(d);
              } else if (t === "RESUMED") {
                log?.info(`[qqbot:${account.accountId}] Session resumed`);
                // P1-2: 更新 Session 连接时间
                if (sessionId) {
                  saveSession({
                    sessionId,
                    lastSeq,
                    lastConnectedAt: Date.now(),
                    intentLevelIndex: lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex,
                    accountId: account.accountId,
                    savedAt: Date.now(),
                    appId: account.appId,
                  });
                }
              } else if (t === "C2C_MESSAGE_CREATE") {
                const event = d as C2CMessageEvent;
                // P1-3: 记录已知用户
                recordKnownUser({
                  openid: event.author.user_openid,
                  type: "c2c",
                  accountId: account.accountId,
                });
                // 解析引用索引
                const c2cRefs = parseRefIndices(event.message_scene?.ext);
                // 日志：输出用户输入完整 JSON
                log?.info(`[qqbot:${account.accountId}] ▶ INBOUND C2C RAW: ${JSON.stringify(event)}`);
                // 使用消息队列异步处理，防止阻塞心跳
                enqueueMessage({
                  type: "c2c",
                  senderId: event.author.user_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  attachments: event.attachments,
                  refMsgIdx: c2cRefs.refMsgIdx,
                  msgIdx: c2cRefs.msgIdx,
                });
              } else if (t === "AT_MESSAGE_CREATE") {
                const event = d as GuildMessageEvent;
                // P1-3: 记录已知用户（频道用户）
                recordKnownUser({
                  openid: event.author.id,
                  type: "c2c", // 频道用户按 c2c 类型存储
                  nickname: event.author.username,
                  accountId: account.accountId,
                });
                const guildRefs = parseRefIndices((event as any).message_scene?.ext);
                log?.info(`[qqbot:${account.accountId}] ▶ INBOUND GUILD RAW: ${JSON.stringify(event)}`);
                enqueueMessage({
                  type: "guild",
                  senderId: event.author.id,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  channelId: event.channel_id,
                  guildId: event.guild_id,
                  attachments: event.attachments,
                  refMsgIdx: guildRefs.refMsgIdx,
                  msgIdx: guildRefs.msgIdx,
                });
              } else if (t === "DIRECT_MESSAGE_CREATE") {
                const event = d as GuildMessageEvent;
                // P1-3: 记录已知用户（频道私信用户）
                recordKnownUser({
                  openid: event.author.id,
                  type: "c2c",
                  nickname: event.author.username,
                  accountId: account.accountId,
                });
                const dmRefs = parseRefIndices((event as any).message_scene?.ext);
                log?.info(`[qqbot:${account.accountId}] ▶ INBOUND DM RAW: ${JSON.stringify(event)}`);
                enqueueMessage({
                  type: "dm",
                  senderId: event.author.id,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  guildId: event.guild_id,
                  attachments: event.attachments,
                  refMsgIdx: dmRefs.refMsgIdx,
                  msgIdx: dmRefs.msgIdx,
                });
              } else if (t === "GROUP_AT_MESSAGE_CREATE") {
                const event = d as GroupMessageEvent;
                // P1-3: 记录已知用户（群组用户）
                recordKnownUser({
                  openid: event.author.member_openid,
                  type: "group",
                  groupOpenid: event.group_openid,
                  accountId: account.accountId,
                });
                const groupRefs = parseRefIndices(event.message_scene?.ext);
                log?.info(`[qqbot:${account.accountId}] ▶ INBOUND GROUP RAW: ${JSON.stringify(event)}`);
                enqueueMessage({
                  type: "group",
                  senderId: event.author.member_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  groupOpenid: event.group_openid,
                  attachments: event.attachments,
                  refMsgIdx: groupRefs.refMsgIdx,
                  msgIdx: groupRefs.msgIdx,
                });
              }
              break;

            case 11: // Heartbeat ACK
              log?.debug?.(`[qqbot:${account.accountId}] Heartbeat ACK`);
              break;

            case 7: // Reconnect
              log?.info(`[qqbot:${account.accountId}] Server requested reconnect`);
              cleanup();
              scheduleReconnect();
              break;

            case 9: // Invalid Session
              const canResume = d as boolean;
              const currentLevel = INTENT_LEVELS[intentLevelIndex];
              log?.error(`[qqbot:${account.accountId}] Invalid session (${currentLevel.description}), can resume: ${canResume}, raw: ${rawData}`);
              
              if (!canResume) {
                sessionId = null;
                lastSeq = null;
                // P1-2: 清除持久化的 Session
                clearSession(account.accountId);
                
                // 尝试降级到下一个权限级别
                if (intentLevelIndex < INTENT_LEVELS.length - 1) {
                  intentLevelIndex++;
                  const nextLevel = INTENT_LEVELS[intentLevelIndex];
                  log?.info(`[qqbot:${account.accountId}] Downgrading intents to: ${nextLevel.description}`);
                } else {
                  // 已经是最低权限级别了
                  log?.error(`[qqbot:${account.accountId}] All intent levels failed. Please check AppID/Secret.`);
                  shouldRefreshToken = true;
                }
              }
              cleanup();
              // Invalid Session 后等待一段时间再重连
              scheduleReconnect(3000);
              break;
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message parse error: ${err}`);
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`[qqbot:${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        isConnecting = false; // 释放锁
        
        // 根据错误码处理（参考 QQ 官方文档）
        // 4004: CODE_INVALID_TOKEN - Token 无效，需刷新 token 重新连接
        // 4006: CODE_SESSION_NO_LONGER_VALID - 会话失效，需重新 identify
        // 4007: CODE_INVALID_SEQ - Resume 时 seq 无效，需重新 identify
        // 4008: CODE_RATE_LIMITED - 限流断开，等待后重连
        // 4009: CODE_SESSION_TIMED_OUT - 会话超时，需重新 identify
        // 4900-4913: 内部错误，需要重新 identify
        // 4914: 机器人已下架
        // 4915: 机器人已封禁
        if (code === 4914 || code === 4915) {
          log?.error(`[qqbot:${account.accountId}] Bot is ${code === 4914 ? "offline/sandbox-only" : "banned"}. Please contact QQ platform.`);
          cleanup();
          // 不重连，直接退出
          return;
        }
        
        // 4004: Token 无效，强制刷新 token 后重连
        if (code === 4004) {
          log?.info(`[qqbot:${account.accountId}] Invalid token (4004), will refresh token and reconnect`);
          shouldRefreshToken = true;
          cleanup();
          if (!isAborted) {
            scheduleReconnect();
          }
          return;
        }
        
        // 4008: 限流断开，等待后重连（不需要重新 identify）
        if (code === 4008) {
          log?.info(`[qqbot:${account.accountId}] Rate limited (4008), waiting ${RATE_LIMIT_DELAY}ms before reconnect`);
          cleanup();
          if (!isAborted) {
            scheduleReconnect(RATE_LIMIT_DELAY);
          }
          return;
        }
        
        // 4006/4007/4009: 会话失效或超时，需要清除 session 重新 identify
        if (code === 4006 || code === 4007 || code === 4009) {
          const codeDesc: Record<number, string> = {
            4006: "session no longer valid",
            4007: "invalid seq on resume",
            4009: "session timed out",
          };
          log?.info(`[qqbot:${account.accountId}] Error ${code} (${codeDesc[code]}), will re-identify`);
          sessionId = null;
          lastSeq = null;
          // 清除持久化的 Session
          clearSession(account.accountId);
          shouldRefreshToken = true;
        } else if (code >= 4900 && code <= 4913) {
          // 4900-4913 内部错误，清除 session 重新 identify
          log?.info(`[qqbot:${account.accountId}] Internal error (${code}), will re-identify`);
          sessionId = null;
          lastSeq = null;
          // 清除持久化的 Session
          clearSession(account.accountId);
          shouldRefreshToken = true;
        }
        
        // 检测是否是快速断开（连接后很快就断了）
        const connectionDuration = Date.now() - lastConnectTime;
        if (connectionDuration < QUICK_DISCONNECT_THRESHOLD && lastConnectTime > 0) {
          quickDisconnectCount++;
          log?.info(`[qqbot:${account.accountId}] Quick disconnect detected (${connectionDuration}ms), count: ${quickDisconnectCount}`);
          
          // 如果连续快速断开超过阈值，等待更长时间
          if (quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
            log?.error(`[qqbot:${account.accountId}] Too many quick disconnects. This may indicate a permission issue.`);
            log?.error(`[qqbot:${account.accountId}] Please check: 1) AppID/Secret correct 2) Bot permissions on QQ Open Platform`);
            quickDisconnectCount = 0;
            cleanup();
            // 快速断开太多次，等待更长时间再重连
            if (!isAborted && code !== 1000) {
              scheduleReconnect(RATE_LIMIT_DELAY);
            }
            return;
          }
        } else {
          // 连接持续时间够长，重置计数
          quickDisconnectCount = 0;
        }
        
        cleanup();
        
        // 非正常关闭则重连
        if (!isAborted && code !== 1000) {
          scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        log?.error(`[qqbot:${account.accountId}] WebSocket error: ${err.message}`);
        onError?.(err);
      });

    } catch (err) {
      isConnecting = false; // 释放锁
      const errMsg = String(err);
      log?.error(`[qqbot:${account.accountId}] Connection failed: ${err}`);
      
      // 如果是频率限制错误，等待更长时间
      if (errMsg.includes("Too many requests") || errMsg.includes("100001")) {
        log?.info(`[qqbot:${account.accountId}] Rate limited, waiting ${RATE_LIMIT_DELAY}ms before retry`);
        scheduleReconnect(RATE_LIMIT_DELAY);
      } else {
        scheduleReconnect();
      }
    }
  };

  // 开始连接
  await connect();

  // 等待 abort 信号
  return new Promise((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
