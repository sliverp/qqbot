import WebSocket from "ws";
import path from "node:path";
import * as fs from "node:fs";
import type { ResolvedQQBotAccount, WSPayload, C2CMessageEvent, GuildMessageEvent, GroupMessageEvent } from "./types.js";
import { getAccessToken, getGatewayUrl, sendC2CMessage, sendChannelMessage, sendGroupMessage, clearTokenCache, sendC2CImageMessage, sendGroupImageMessage, initApiConfig, startBackgroundTokenRefresh, stopBackgroundTokenRefresh, sendC2CInputNotify } from "./api.js";
import { loadSession, saveSession, clearSession, type SessionState } from "./session-store.js";
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { getQQBotRuntime } from "./runtime.js";
import { startImageServer, isImageServerRunning, downloadFile, type ImageServerConfig } from "./image-server.js";
import { getImageSize, formatQQBotMarkdownImage, hasQQBotImageSize, DEFAULT_IMAGE_SIZE } from "./utils/image-size.js";
import { parseQQBotPayload, encodePayloadForCron, isCronReminderPayload, isMediaPayload, type CronReminderPayload, type MediaPayload } from "./utils/payload.js";
import { convertSilkToWav, isVoiceAttachment, formatDuration } from "./utils/audio-convert.js";

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
const IMAGE_SERVER_DIR = process.env.QQBOT_IMAGE_SERVER_DIR || path.join(process.env.HOME || "/home/ubuntu", ".openclaw", "qqbot", "images");

// 消息队列配置（异步处理，防止阻塞心跳）
const MESSAGE_QUEUE_SIZE = 1000; // 最大队列长度
const MESSAGE_QUEUE_WARN_THRESHOLD = 800; // 队列告警阈值

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
  attachments?: Array<{ content_type: string; url: string; filename?: string }>;
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

  // 初始化 API 配置（markdown 支持）
  initApiConfig({
    markdownSupport: account.markdownSupport,
  });
  log?.info(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport === true}`);

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
  const savedSession = loadSession(account.accountId);
  if (savedSession) {
    sessionId = savedSession.sessionId;
    lastSeq = savedSession.lastSeq;
    intentLevelIndex = savedSession.intentLevelIndex;
    lastSuccessfulIntentLevel = savedSession.intentLevelIndex;
    log?.info(`[qqbot:${account.accountId}] Restored session from storage: sessionId=${sessionId}, lastSeq=${lastSeq}, intentLevel=${intentLevelIndex}`);
  }

  // ============ 消息队列（异步处理，防止阻塞心跳） ============
  const messageQueue: QueuedMessage[] = [];
  let messageProcessorRunning = false;
  let messagesProcessed = 0; // 统计已处理消息数

  /**
   * 将消息加入队列（非阻塞）
   */
  const enqueueMessage = (msg: QueuedMessage): void => {
    if (messageQueue.length >= MESSAGE_QUEUE_SIZE) {
      // 队列满了，丢弃最旧的消息
      const dropped = messageQueue.shift();
      log?.error(`[qqbot:${account.accountId}] Message queue full, dropping oldest message from ${dropped?.senderId}`);
    }
    if (messageQueue.length >= MESSAGE_QUEUE_WARN_THRESHOLD) {
      log?.info(`[qqbot:${account.accountId}] Message queue size: ${messageQueue.length}/${MESSAGE_QUEUE_SIZE}`);
    }
    messageQueue.push(msg);
    log?.debug?.(`[qqbot:${account.accountId}] Message enqueued, queue size: ${messageQueue.length}`);
  };

  /**
   * 启动消息处理循环（独立于 WS 消息循环）
   */
  const startMessageProcessor = (handleMessageFn: (msg: QueuedMessage) => Promise<void>): void => {
    if (messageProcessorRunning) return;
    messageProcessorRunning = true;

    const processLoop = async () => {
      while (!isAborted) {
        if (messageQueue.length === 0) {
          // 队列为空，等待一小段时间
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }

        const msg = messageQueue.shift()!;
        try {
          await handleMessageFn(msg);
          messagesProcessed++;
        } catch (err) {
          // 捕获处理异常，防止影响队列循环
          log?.error(`[qqbot:${account.accountId}] Message processor error: ${err}`);
        }
      }
      messageProcessorRunning = false;
      log?.info(`[qqbot:${account.accountId}] Message processor stopped`);
    };

    // 异步启动，不阻塞调用者
    processLoop().catch(err => {
      log?.error(`[qqbot:${account.accountId}] Message processor crashed: ${err}`);
      messageProcessorRunning = false;
    });

    log?.info(`[qqbot:${account.accountId}] Message processor started`);
  };

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanup();
    // P1-1: 停止后台 Token 刷新
    stopBackgroundTokenRefresh();
    // P1-3: 保存已知用户数据
    flushKnownUsers();
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
        clearTokenCache();
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
        attachments?: Array<{ content_type: string; url: string; filename?: string }>;
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

        try{
          await sendC2CInputNotify(accessToken, event.senderId, event.messageId, 60);
          log?.info(`[qqbot:${account.accountId}] Sent input notify to ${event.senderId}`);
        }catch(err){
          log?.error(`[qqbot:${account.accountId}] sendC2CInputNotify error: ${err}`);
        }

        const isGroup = event.type === "guild" || event.type === "group";
        const peerId = event.type === "guild" ? `channel:${event.channelId}` 
                     : event.type === "group" ? `group:${event.groupOpenid}`
                     : event.senderId;

        const route = pluginRuntime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "qqbot",
          accountId: account.accountId,
          peer: {
            kind: isGroup ? "group" : "dm",
            id: peerId,
          },
        });

        const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);

        // 组装消息体
        // 静态系统提示已移至 skills/qqbot-cron/SKILL.md 和 skills/qqbot-media/SKILL.md
        // BodyForAgent 只保留必要的动态上下文信息
        
        // ============ 用户标识信息（用于定时提醒和主动消息） ============
        const isGroupChat = event.type === "group";
        const targetAddress = isGroupChat ? `group:${event.groupOpenid}` : event.senderId;
        
        // 收集额外的系统提示（如果配置了账户级别的 systemPrompt）
        const systemPrompts: string[] = [];
        if (account.systemPrompt) {
          systemPrompts.push(account.systemPrompt);
        }
        
        // 处理附件（图片等）- 下载到本地供 clawdbot 访问
        let attachmentInfo = "";
        const imageUrls: string[] = [];
        const imageMediaTypes: string[] = [];
        // 存到 .openclaw/qqbot 目录下的 downloads 文件夹
        const downloadDir = path.join(process.env.HOME || "/home/ubuntu", ".openclaw", "qqbot", "downloads");
        
        if (event.attachments?.length) {
          // ============ 接收附件描述生成（图片 / 语音 / 其他） ============
          const imageDescriptions: string[] = [];
          const voiceDescriptions: string[] = [];
          const otherAttachments: string[] = [];
          
          for (const att of event.attachments) {
            // 下载附件到本地，使用原始文件名
            const localPath = await downloadFile(att.url, downloadDir, att.filename);
            if (localPath) {
              if (att.content_type?.startsWith("image/")) {
                imageUrls.push(localPath);
                imageMediaTypes.push(att.content_type);
                
                // 构建自然语言描述（根据需求 4.2）
                const format = att.content_type?.split("/")[1] || "未知格式";
                const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
                
                imageDescriptions.push(`
用户发送了一张图片：
- 图片地址：${localPath}
- 图片格式：${format}
- 消息ID：${event.messageId}
- 发送时间：${timestamp}

请根据图片内容进行回复。`);
              } else if (isVoiceAttachment(att)) {
                // ============ 语音消息处理：SILK → WAV ============
                log?.info(`[qqbot:${account.accountId}] Voice attachment detected: ${att.filename}, converting SILK to WAV...`);
                try {
                  const result = await convertSilkToWav(localPath, downloadDir);
                  if (result) {
                    const durationStr = formatDuration(result.duration);
                    log?.info(`[qqbot:${account.accountId}] Voice converted: ${result.wavPath} (duration: ${durationStr})`);
                    
                    const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
                    voiceDescriptions.push(`
用户发送了一条语音消息：
- 语音文件：${result.wavPath}
- 语音时长：${durationStr}
- 发送时间：${timestamp}`);
                  } else {
                    // SILK 解码失败，保留原始文件
                    log?.info(`[qqbot:${account.accountId}] Voice file is not SILK format, keeping original: ${localPath}`);
                    voiceDescriptions.push(`
用户发送了一条语音消息（非SILK格式，无法转换）：
- 语音文件：${localPath}
- 原始格式：${att.filename || "unknown"}
- 消息ID：${event.messageId}

请告知用户该语音格式暂不支持解析。`);
                  }
                } catch (convertErr) {
                  log?.error(`[qqbot:${account.accountId}] Voice conversion failed: ${convertErr}`);
                  voiceDescriptions.push(`
用户发送了一条语音消息（转换失败）：
- 原始文件：${localPath}
- 错误信息：${convertErr}
- 消息ID：${event.messageId}

请告知用户语音处理出现问题。`);
                }
              } else {
                otherAttachments.push(`[附件: ${localPath}]`);
              }
              log?.info(`[qqbot:${account.accountId}] Downloaded attachment to: ${localPath}`);
            } else {
              // 下载失败，提供原始 URL 作为后备
              log?.error(`[qqbot:${account.accountId}] Failed to download attachment: ${att.url}`);
              if (att.content_type?.startsWith("image/")) {
                imageUrls.push(att.url);
                imageMediaTypes.push(att.content_type);
                
                // 下载失败时的自然语言描述
                const format = att.content_type?.split("/")[1] || "未知格式";
                const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
                
                imageDescriptions.push(`
用户发送了一张图片（下载失败，使用原始URL）：
- 图片地址：${att.url}
- 图片格式：${format}
- 消息ID：${event.messageId}
- 发送时间：${timestamp}

请根据图片内容进行回复。`);
              } else {
                otherAttachments.push(`[附件: ${att.filename ?? att.content_type}] (下载失败)`);
              }
            }
          }
          
          // 组合附件信息：先图片描述，后语音描述，后其他附件
          if (imageDescriptions.length > 0) {
            attachmentInfo += "\n" + imageDescriptions.join("\n");
          }
          if (voiceDescriptions.length > 0) {
            attachmentInfo += "\n" + voiceDescriptions.join("\n");
          }
          if (otherAttachments.length > 0) {
            attachmentInfo += "\n" + otherAttachments.join("\n");
          }
        }
        
        // 解析 QQ 表情标签，将 <faceType=...,ext="base64"> 替换为 【表情: 中文名】
        const parsedContent = parseFaceTags(event.content);
        const userContent = parsedContent + attachmentInfo;
        let messageBody = `【系统提示】\n${systemPrompts.join("\n")}\n\n【用户输入】\n${userContent}`;

        if(userContent.startsWith("/")){ // 保留Openclaw原始命令
          messageBody = userContent
        }

        const body = pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "qqbot",
          from: event.senderName ?? event.senderId,
          timestamp: new Date(event.timestamp).getTime(),
          body: userContent,
          chatType: isGroup ? "group" : "direct",
          sender: {
            id: event.senderId,
            name: event.senderName,
          },
          envelope: envelopeOptions,
          // 传递图片 URL 列表
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
        });
        
        // AI 可见的完整上下文（简洁的动态信息 + 用户消息）
        // 静态能力说明已通过 skills 加载，这里只提供必要的运行时上下文
        // 📌 关键：直接注入图片发送说明，确保 AI 知道如何发送图片
        const nowMs = Date.now();
        const contextInfo = `你正在通过 QQ 与用户对话。

【本次会话上下文】
- 用户: ${event.senderName || "未知"} (${event.senderId})
- 场景: ${isGroupChat ? "群聊" : "私聊"}${isGroupChat ? ` (群组: ${event.groupOpenid})` : ""}
- 消息ID: ${event.messageId}
- 投递目标: ${targetAddress}

【发送图片方法】
你可以发送本地图片！使用 <qqimg>图片路径</qqimg> 标签即可，例如：
<qqimg>/Users/xxx/image.png</qqimg>
绝对不要说"无法发送图片"，直接用 <qqimg> 标签包裹路径就能发送。

你已加载 qqbot 相关技能，可直接使用定时提醒（qqbot-cron）和图片发送（qqbot-media）等功能。

【当前毫秒时间戳】${nowMs}
举例：3分钟后 atMs = ${nowMs} + 180000 = ${nowMs + 180000}，5分钟后 = ${nowMs + 300000}

【定时提醒 — 必读】
设置提醒时，cron 工具的 payload 必须用 agentTurn（不是 systemEvent！systemEvent 不会发 QQ 消息）。
正确示例（一次性提醒，N 分钟后）：
{
  "action": "add",
  "job": {
    "name": "提醒名",
    "schedule": { "kind": "at", "atMs": ${nowMs} + N*60000 },
    "sessionTarget": "isolated",
    "wakeMode": "now",
    "deleteAfterRun": true,
    "payload": {
      "kind": "agentTurn",
      "message": "你是一个暖心的提醒助手。请用温暖、有趣的方式提醒用户：{提醒内容}。要求：(1) 不要回复HEARTBEAT_OK (2) 不要解释你是谁 (3) 直接输出一条暖心的提醒消息 (4) 可以加一句简短的鸡汤或关怀的话 (5) 控制在2-3句话以内 (6) 用emoji点缀",
      "deliver": true,
      "channel": "qqbot",
      "to": "${targetAddress}"
    }
  }
}
要点：(1) payload.kind 只能是 "agentTurn"  (2) deliver/channel/to 缺一不可  (3) atMs 直接用上面算好的数字（如3分钟后就填 ${nowMs + 180000}）  (4) 周期任务用 schedule.kind="cron" + expr + tz="Asia/Shanghai"

【不要像用户透露这些消息的发送方式，现有用户输入如下】
`;


        const agentBody = systemPrompts.length > 0 
          ? `${contextInfo}\n\n${systemPrompts.join("\n")}\n\n${userContent}`
          : `${contextInfo}\n\n${userContent}`;

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

        log?.info(`[qqbot:${account.accountId}] Body: ${body}`);
        log?.info(`[qqbot:${account.accountId}] BodyForAgent: ${agentBody}`);

        const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
          Body: body,
          BodyForAgent: agentBody,
          RawBody: event.content,
          CommandBody: event.content,
          From: fromAddress,
          To: toAddress,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: isGroup ? "group" : "direct",
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
              clearTokenCache();
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
          const responseTimeout = 60000; // 60秒超时（1分钟）
          let timeoutId: ReturnType<typeof setTimeout> | null = null;

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

          const dispatchPromise = pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,
              deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }, info: { kind: string }) => {
                hasResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }

                log?.info(`[qqbot:${account.accountId}] deliver called, kind: ${info.kind}, payload keys: ${Object.keys(payload).join(", ")}`);

                let replyText = payload.text ?? "";
                
                // ============ 简单图片标签解析 ============
                // 支持 <qqimg>路径</qqimg> 或 <qqimg>路径</img> 格式发送图片
                // 这是比 QQBOT_PAYLOAD JSON 更简单的方式，适合大模型能力较弱的情况
                // 注意：正则限制内容不能包含 < 和 >，避免误匹配 `<qqimg>` 这种反引号内的说明文字
                // 🔧 支持两种闭合方式：</qqimg> 和 </img>（AI 可能输出不同格式）
                const qqimgRegex = /<qqimg>([^<>]+)<\/(?:qqimg|img)>/gi;
                const qqimgMatches = [...replyText.matchAll(qqimgRegex)];
                
                if (qqimgMatches.length > 0) {
                  log?.info(`[qqbot:${account.accountId}] Detected ${qqimgMatches.length} <qqimg> tag(s)`);
                  
                  // 构建发送队列：根据内容在原文中的实际位置顺序发送
                  // type: 'text' | 'image', content: 文本内容或图片路径
                  const sendQueue: Array<{ type: "text" | "image"; content: string }> = [];
                  
                  let lastIndex = 0;
                  // 使用新的正则来获取带索引的匹配结果（支持 </qqimg> 和 </img> 两种闭合方式）
                  const qqimgRegexWithIndex = /<qqimg>([^<>]+)<\/(?:qqimg|img)>/gi;
                  let match;
                  
                  while ((match = qqimgRegexWithIndex.exec(replyText)) !== null) {
                    // 添加标签前的文本
                    const textBefore = replyText.slice(lastIndex, match.index).replace(/\n{3,}/g, "\n\n").trim();
                    if (textBefore) {
                      sendQueue.push({ type: "text", content: filterInternalMarkers(textBefore) });
                    }
                    
                    // 添加图片
                    const imagePath = match[1]?.trim();
                    if (imagePath) {
                      sendQueue.push({ type: "image", content: imagePath });
                      log?.info(`[qqbot:${account.accountId}] Found image path in <qqimg>: ${imagePath}`);
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
                          if (event.type === "c2c") {
                            await sendC2CMessage(token, event.senderId, item.content, event.messageId);
                          } else if (event.type === "group" && event.groupOpenid) {
                            await sendGroupMessage(token, event.groupOpenid, item.content, event.messageId);
                          } else if (event.channelId) {
                            await sendChannelMessage(token, event.channelId, item.content, event.messageId);
                          }
                        });
                        log?.info(`[qqbot:${account.accountId}] Sent text: ${item.content.slice(0, 50)}...`);
                      } catch (err) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send text: ${err}`);
                      }
                    } else if (item.type === "image") {
                      // 发送图片
                      const imagePath = item.content;
                      try {
                        let imageUrl = imagePath;
                        
                        // 判断是本地文件还是 URL
                        const isLocalPath = imagePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(imagePath);
                        const isHttpUrl = imagePath.startsWith("http://") || imagePath.startsWith("https://");
                        
                        if (isLocalPath) {
                          // 本地文件：转换为 Base64 Data URL
                          if (!fs.existsSync(imagePath)) {
                            log?.error(`[qqbot:${account.accountId}] Image file not found: ${imagePath}`);
                            await sendErrorMessage(`图片文件不存在: ${imagePath}`);
                            continue;
                          }
                          
                          const fileBuffer = fs.readFileSync(imagePath);
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
                          log?.info(`[qqbot:${account.accountId}] Converted local image to Base64 (size: ${fileBuffer.length} bytes)`);
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
                        // 处理图片发送
                        let imageUrl = parsedPayload.path;
                        
                        // 如果是本地文件，转换为 Base64 Data URL
                        if (parsedPayload.source === "file") {
                          try {
                            if (!fs.existsSync(imageUrl)) {
                              await sendErrorMessage(`[QQBot] 图片文件不存在: ${imageUrl}`);
                              return;
                            }
                            const fileBuffer = fs.readFileSync(imageUrl);
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
                            log?.info(`[qqbot:${account.accountId}] Converted local image to Base64 (size: ${fileBuffer.length} bytes)`);
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
                          await sendErrorMessage(`[QQBot] 发送图片失败: ${err}`);
                        }
                      } else if (parsedPayload.mediaType === "audio") {
                        // 音频发送暂不支持
                        log?.info(`[qqbot:${account.accountId}] Audio sending not yet implemented`);
                        await sendErrorMessage(`[QQBot] 音频发送功能暂未实现，敬请期待~`);
                      } else if (parsedPayload.mediaType === "video") {
                        // 视频发送暂不支持
                        log?.info(`[qqbot:${account.accountId}] Video sending not supported`);
                        await sendErrorMessage(`[QQBot] 视频发送功能暂不支持`);
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
                  
                  // ⚠️ 本地文件路径不再在此处处理，应使用 <qqimg> 标签
                  const isLocalPath = url.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(url);
                  if (isLocalPath) {
                    log?.info(`[qqbot:${account.accountId}] 💡 Local path detected in non-structured message (not sending): ${url}`);
                    log?.info(`[qqbot:${account.accountId}] 💡 Hint: Use <qqimg>${url}</qqimg> tag to send local images`);
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
                    } else if (/^\/?(?:Users|home|tmp|var|private|[A-Z]:)/i.test(url)) {
                      // 本地路径：记录日志提示，但不发送
                      log?.info(`[qqbot:${account.accountId}] ⚠️ Local path in markdown (not sending): ${url}`);
                      log?.info(`[qqbot:${account.accountId}] 💡 Use <qqimg>${url}</qqimg> tag to send local images`);
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
                        if (event.type === "c2c") {
                          await sendC2CMessage(token, event.senderId, textWithoutImages, event.messageId);
                        } else if (event.type === "group" && event.groupOpenid) {
                          await sendGroupMessage(token, event.groupOpenid, textWithoutImages, event.messageId);
                        } else if (event.channelId) {
                          await sendChannelMessage(token, event.channelId, textWithoutImages, event.messageId);
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
                        if (event.type === "c2c") {
                          await sendC2CMessage(token, event.senderId, textWithoutImages, event.messageId);
                        } else if (event.type === "group" && event.groupOpenid) {
                          await sendGroupMessage(token, event.groupOpenid, textWithoutImages, event.messageId);
                        } else if (event.channelId) {
                          await sendChannelMessage(token, event.channelId, textWithoutImages, event.messageId);
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
                  await sendErrorMessage("大模型 API Key 可能无效，请检查配置");
                } else {
                  // 显示完整错误信息，截取前 500 字符
                  await sendErrorMessage(`出错: ${errMsg.slice(0, 500)}`);
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
              await sendErrorMessage("QQ已经收到了你的请求并转交给了OpenClaw，任务可能比较复杂，正在处理中...");
            }
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message processing failed: ${err}`);
          await sendErrorMessage(`处理失败: ${String(err).slice(0, 500)}`);
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
                // 使用消息队列异步处理，防止阻塞心跳
                enqueueMessage({
                  type: "c2c",
                  senderId: event.author.user_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  attachments: event.attachments,
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
                enqueueMessage({
                  type: "dm",
                  senderId: event.author.id,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  guildId: event.guild_id,
                  attachments: event.attachments,
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
                enqueueMessage({
                  type: "group",
                  senderId: event.author.member_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  groupOpenid: event.group_openid,
                  attachments: event.attachments,
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
