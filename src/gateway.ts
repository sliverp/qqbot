import WebSocket from "ws";
import path from "node:path";
import type { ResolvedQQBotAccount, WSPayload, C2CMessageEvent, GuildMessageEvent, GroupMessageEvent } from "./types.js";
import { getAccessToken, getGatewayUrl, sendC2CMessage, sendChannelMessage, sendGroupMessage, clearTokenCache, sendC2CImageMessage, sendGroupImageMessage, sendC2CInputNotify } from "./api.js";
import { getQQBotRuntime } from "./runtime.js";
import { startImageServer, saveImage, saveImageFromPath, isImageServerRunning, downloadFile, type ImageServerConfig } from "./image-server.js";

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
const IMAGE_SERVER_DIR = process.env.QQBOT_IMAGE_SERVER_DIR || path.join(process.env.HOME || "/home/ubuntu", "clawd", "qqbot-images");

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
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
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

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanup();
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
        log?.info(`[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`);
        if (event.attachments?.length) {
          log?.info(`[qqbot:${account.accountId}] Attachments: ${event.attachments.length}`);
        }

        // 对于 C2C 消息，先发送输入状态提示用户机器人正在输入
        if (event.type === "c2c") {
          try {
            const token = await getAccessToken(account.appId, account.clientSecret);
            await sendC2CInputNotify(token, event.senderId, event.messageId, 60);
            log?.info(`[qqbot:${account.accountId}] Sent input notify to ${event.senderId}`);
          } catch (err) {
            log?.error(`[qqbot:${account.accountId}] Failed to send input notify: ${err}`);
          }
        }

        pluginRuntime.channel.activity.record({
          channel: "qqbot",
          accountId: account.accountId,
          direction: "inbound",
        });

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

        // 组装消息体，添加系统提示词
        let builtinPrompt = "";
        
        // 只有配置了图床公网地址，才告诉 AI 可以发送图片
        if (imageServerBaseUrl) {
          builtinPrompt += `

【发送图片】
你可以发送本地图片文件给用户。只需在回复中直接引用图片的绝对路径即可，系统会自动处理。
支持 png、jpg、gif、webp 格式。`;
        }
        
        const systemPrompts = [builtinPrompt];
        if (account.systemPrompt) {
          systemPrompts.push(account.systemPrompt);
        }
        
        // 处理附件（图片等）- 下载到本地供 clawdbot 访问
        let attachmentInfo = "";
        const imageUrls: string[] = [];
        // 存到 clawdbot 工作目录下的 downloads 文件夹
        const downloadDir = path.join(process.env.HOME || "/home/ubuntu", "clawd", "downloads");
        
        if (event.attachments?.length) {
          for (const att of event.attachments) {
            // 下载附件到本地，使用原始文件名
            const localPath = await downloadFile(att.url, downloadDir, att.filename);
            if (localPath) {
              if (att.content_type?.startsWith("image/")) {
                imageUrls.push(localPath);
                attachmentInfo += `\n[图片: ${localPath}]`;
              } else {
                attachmentInfo += `\n[附件: ${localPath}]`;
              }
              log?.info(`[qqbot:${account.accountId}] Downloaded attachment to: ${localPath}`);
            } else {
              // 下载失败，提供原始 URL 作为后备
              log?.error(`[qqbot:${account.accountId}] Failed to download attachment: ${att.url}`);
              if (att.content_type?.startsWith("image/")) {
                imageUrls.push(att.url);
                attachmentInfo += `\n[图片: ${att.url}] (下载失败，可能无法访问)`;
              } else {
                attachmentInfo += `\n[附件: ${att.filename ?? att.content_type}] (下载失败)`;
              }
            }
          }
        }
        
        const userContent = event.content + attachmentInfo;
        const messageBody = `【系统提示】\n${systemPrompts.join("\n")}\n\n【用户输入】\n${userContent}`;

        const body = pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "QQBot",
          from: event.senderName ?? event.senderId,
          timestamp: new Date(event.timestamp).getTime(),
          body: messageBody,
          chatType: isGroup ? "group" : "direct",
          sender: {
            id: event.senderId,
            name: event.senderName,
          },
          envelope: envelopeOptions,
          // 传递图片 URL 列表
          ...(imageUrls.length > 0 ? { imageUrls } : {}),
        });

        const fromAddress = event.type === "guild" ? `qqbot:channel:${event.channelId}`
                         : event.type === "group" ? `qqbot:group:${event.groupOpenid}`
                         : `qqbot:${event.senderId}`;
        const toAddress = fromAddress;

        const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
          Body: body,
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
          const responseTimeout = 30000; // 30秒超时
          let timeoutId: ReturnType<typeof setTimeout> | null = null;

          const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
              if (!hasResponse) {
                reject(new Error("Response timeout"));
              }
            }, responseTimeout);
          });

          const dispatchPromise = pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,
              deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }) => {
                hasResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }

                log?.info(`[qqbot:${account.accountId}] deliver called, payload keys: ${Object.keys(payload).join(", ")}`);

                let replyText = payload.text ?? "";
                
                // 收集所有图片路径
                const imageUrls: string[] = [];
                
                // 处理 mediaUrls 和 mediaUrl 字段（本地文件路径）
                const mediaPaths: string[] = [];
                if (payload.mediaUrls?.length) {
                  mediaPaths.push(...payload.mediaUrls);
                }
                if (payload.mediaUrl && !mediaPaths.includes(payload.mediaUrl)) {
                  mediaPaths.push(payload.mediaUrl);
                }
                
                for (const localPath of mediaPaths) {
                  if (localPath && imageServerBaseUrl) {
                    try {
                      const savedUrl = saveImageFromPath(localPath);
                      if (savedUrl) {
                        imageUrls.push(savedUrl);
                        log?.info(`[qqbot:${account.accountId}] Saved media to server: ${localPath}`);
                      } else {
                        log?.error(`[qqbot:${account.accountId}] Failed to save media (not found or not image): ${localPath}`);
                      }
                    } catch (err) {
                      log?.error(`[qqbot:${account.accountId}] Failed to save media: ${err}`);
                    }
                  }
                }
                
                // 如果没有文本也没有图片，跳过
                if (!replyText.trim() && imageUrls.length === 0) {
                  log?.info(`[qqbot:${account.accountId}] Empty reply, skipping`);
                  return;
                }

                // 0. 提取 MEDIA: 前缀的本地文件路径（从文本中）
                const mediaPathRegex = /MEDIA:([^\s\n]+)/gi;
                const mediaMatches = [...replyText.matchAll(mediaPathRegex)];
                
                for (const match of mediaMatches) {
                  const localPath = match[1];
                  if (localPath && imageServerBaseUrl) {
                    // 将本地文件复制到图床
                    try {
                      const savedUrl = saveImageFromPath(localPath);
                      if (savedUrl) {
                        imageUrls.push(savedUrl);
                        log?.info(`[qqbot:${account.accountId}] Saved local image to server: ${localPath}`);
                      } else {
                        log?.error(`[qqbot:${account.accountId}] Failed to save local image (not found or not image): ${localPath}`);
                      }
                    } catch (err) {
                      log?.error(`[qqbot:${account.accountId}] Failed to save local image: ${err}`);
                    }
                  }
                  // 从文本中移除 MEDIA: 行
                  replyText = replyText.replace(match[0], "").trim();
                }
                
                // 0.5. 提取本地绝对文件路径（/path/to/image.png 或 /path/to/image_123_png 格式）
                // 支持标准扩展名和下划线替换后的扩展名
                const localPathRegex = /(\/[^\s\n]+?(?:\.(?:png|jpg|jpeg|gif|webp)|_(?:png|jpg|jpeg|gif|webp)(?:\s|$)))/gi;
                const localPathMatches = [...replyText.matchAll(localPathRegex)];
                
                for (const match of localPathMatches) {
                  let localPath = match[1].trim();
                  if (localPath && imageServerBaseUrl) {
                    // 如果是下划线格式的扩展名，转换回点格式
                    localPath = localPath.replace(/_(?=(?:png|jpg|jpeg|gif|webp)$)/, ".");
                    try {
                      const savedUrl = saveImageFromPath(localPath);
                      if (savedUrl) {
                        imageUrls.push(savedUrl);
                        log?.info(`[qqbot:${account.accountId}] Saved local path image to server: ${localPath}`);
                      } else {
                        log?.error(`[qqbot:${account.accountId}] Local path not found or not image: ${localPath}`);
                      }
                    } catch (err) {
                      log?.error(`[qqbot:${account.accountId}] Failed to save local path image: ${err}`);
                    }
                  }
                  // 从文本中移除本地路径
                  replyText = replyText.replace(match[0], "").trim();
                }
                
                // 1. 提取 base64 图片（data:image/xxx;base64,...）
                const base64ImageRegex = /!\[([^\]]*)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)|(?<![(\[])(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/gi;
                const base64Matches = [...replyText.matchAll(base64ImageRegex)];
                
                for (const match of base64Matches) {
                  const dataUrl = match[2] || match[3];
                  if (dataUrl && imageServerBaseUrl) {
                    // 将 base64 保存到本地图床
                    try {
                      const savedUrl = saveImage(dataUrl);
                      imageUrls.push(savedUrl);
                      log?.info(`[qqbot:${account.accountId}] Saved base64 image to local server`);
                    } catch (err) {
                      log?.error(`[qqbot:${account.accountId}] Failed to save base64 image: ${err}`);
                    }
                  }
                  // 从文本中移除 base64
                  replyText = replyText.replace(match[0], "").trim();
                }

                // 2. 提取 URL 图片（Markdown 格式或纯 URL）
                const imageUrlRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s)]*)?)\)|(?<![(\[])(https?:\/\/[^\s)]+\.(?:png|jpg|jpeg|gif|webp)(?:\?[^\s]*)?)/gi;
                const urlMatches = [...replyText.matchAll(imageUrlRegex)];
                
                for (const match of urlMatches) {
                  // match[2] 是 Markdown 格式的 URL，match[3] 是纯 URL
                  const url = match[2] || match[3];
                  if (url) {
                    imageUrls.push(url);
                  }
                }

                try {
                  // 先发送图片（如果有）
                  for (const imageUrl of imageUrls) {
                    try {
                      await sendWithTokenRetry(async (token) => {
                        if (event.type === "c2c") {
                          await sendC2CImageMessage(token, event.senderId, imageUrl, event.messageId);
                        } else if (event.type === "group" && event.groupOpenid) {
                          await sendGroupImageMessage(token, event.groupOpenid, imageUrl, event.messageId);
                        }
                        // 频道消息暂不支持富媒体，跳过图片
                      });
                      log?.info(`[qqbot:${account.accountId}] Sent image: ${imageUrl.slice(0, 50)}...`);
                    } catch (imgErr) {
                      log?.error(`[qqbot:${account.accountId}] Failed to send image: ${imgErr}`);
                      // 图片发送失败时，显示错误信息而不是 URL
                      const errMsg = String(imgErr).slice(0, 200);
                      replyText = `[图片发送失败: ${errMsg}]\n${replyText}`;
                    }
                  }

                  // 再发送文本（如果有）
                  if (replyText.trim()) {
                    await sendWithTokenRetry(async (token) => {
                      if (event.type === "c2c") {
                        await sendC2CMessage(token, event.senderId, replyText, event.messageId);
                      } else if (event.type === "group" && event.groupOpenid) {
                        await sendGroupMessage(token, event.groupOpenid, replyText, event.messageId);
                      } else if (event.channelId) {
                        await sendChannelMessage(token, event.channelId, replyText, event.messageId);
                      }
                    });
                    log?.info(`[qqbot:${account.accountId}] Sent text reply`);
                  }

                  pluginRuntime.channel.activity.record({
                    channel: "qqbot",
                    accountId: account.accountId,
                    direction: "outbound",
                  });
                } catch (err) {
                  log?.error(`[qqbot:${account.accountId}] Send failed: ${err}`);
                }
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
                  await sendErrorMessage("[ClawdBot] 大模型 API Key 可能无效，请检查配置");
                } else {
                  // 显示完整错误信息，截取前 500 字符
                  await sendErrorMessage(`[ClawdBot] 出错: ${errMsg.slice(0, 500)}`);
                }
              },
            },
            replyOptions: {},
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
              await sendErrorMessage("[ClawdBot] QQ响应正常，但未收到clawdbot响应，请检查大模型是否正确配置");
            }
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message processing failed: ${err}`);
          await sendErrorMessage(`[ClawdBot] 处理失败: ${String(err).slice(0, 500)}`);
        }
      };

      ws.on("open", () => {
        log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
        isConnecting = false; // 连接完成，释放锁
        reconnectAttempts = 0; // 连接成功，重置重试计数
        lastConnectTime = Date.now(); // 记录连接时间
      });

      ws.on("message", async (data) => {
        try {
          const rawData = data.toString();
          const payload = JSON.parse(rawData) as WSPayload;
          const { op, d, s, t } = payload;

          if (s) lastSeq = s;

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
                onReady?.(d);
              } else if (t === "RESUMED") {
                log?.info(`[qqbot:${account.accountId}] Session resumed`);
              } else if (t === "C2C_MESSAGE_CREATE") {
                const event = d as C2CMessageEvent;
                await handleMessage({
                  type: "c2c",
                  senderId: event.author.user_openid,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  attachments: event.attachments,
                });
              } else if (t === "AT_MESSAGE_CREATE") {
                const event = d as GuildMessageEvent;
                await handleMessage({
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
                await handleMessage({
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
                await handleMessage({
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
        
        // 根据错误码处理
        // 4009: 可以重新发起 resume
        // 4900-4913: 内部错误，需要重新 identify
        // 4914: 机器人已下架
        // 4915: 机器人已封禁
        if (code === 4914 || code === 4915) {
          log?.error(`[qqbot:${account.accountId}] Bot is ${code === 4914 ? "offline/sandbox-only" : "banned"}. Please contact QQ platform.`);
          cleanup();
          // 不重连，直接退出
          return;
        }
        
        if (code === 4009) {
          // 4009 可以尝试 resume，保留 session
          log?.info(`[qqbot:${account.accountId}] Error 4009, will try resume`);
          shouldRefreshToken = true;
        } else if (code >= 4900 && code <= 4913) {
          // 4900-4913 内部错误，清除 session 重新 identify
          log?.info(`[qqbot:${account.accountId}] Internal error (${code}), will re-identify`);
          sessionId = null;
          lastSeq = null;
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
