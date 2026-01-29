import WebSocket from "ws";
import type { ResolvedQQBotAccount, WSPayload, C2CMessageEvent, GuildMessageEvent, GroupMessageEvent } from "./types.js";
import { getAccessToken, getGatewayUrl, sendC2CMessage, sendChannelMessage, sendGroupMessage, clearTokenCache } from "./api.js";
import { getQQBotRuntime } from "./runtime.js";

// QQ Bot intents
const INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,  // 频道公开消息
  DIRECT_MESSAGE: 1 << 12,         // 频道私信
  GROUP_AND_C2C: 1 << 25,          // 群聊和 C2C 私聊
};

// 重连配置
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]; // 递增延迟
const RATE_LIMIT_DELAY = 60000; // 遇到频率限制时等待 60 秒
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_QUICK_DISCONNECT_COUNT = 3; // 连续快速断开次数阈值
const QUICK_DISCONNECT_THRESHOLD = 5000; // 5秒内断开视为快速断开

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
 * 启动 Gateway WebSocket 连接（带自动重连）
 */
export async function startGateway(ctx: GatewayContext): Promise<void> {
  const { account, abortSignal, cfg, onReady, onError, log } = ctx;

  if (!account.appId || !account.clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
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
        const builtinPrompt = "由于平台限制，你的回复中不可以包含任何URL";
        const systemPrompts = [builtinPrompt];
        if (account.systemPrompt) {
          systemPrompts.push(account.systemPrompt);
        }
        
        // 处理附件（图片等）
        let attachmentInfo = "";
        const imageUrls: string[] = [];
        if (event.attachments?.length) {
          for (const att of event.attachments) {
            if (att.content_type?.startsWith("image/")) {
              imageUrls.push(att.url);
              attachmentInfo += `\n[图片: ${att.url}]`;
            } else {
              attachmentInfo += `\n[附件: ${att.filename ?? att.content_type}]`;
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
              deliver: async (payload: { text?: string }) => {
                hasResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }

                let replyText = payload.text ?? "";
                if (!replyText.trim()) return;

                // 处理回复内容，避免被 QQ 识别为 URL
                const originalText = replyText;
                
                // 把所有可能被识别为 URL 的点替换为下划线
                // 匹配：字母/数字.字母/数字 的模式
                replyText = replyText.replace(/([a-zA-Z0-9])\.([a-zA-Z0-9])/g, "$1_$2");
                
                const hasReplacement = replyText !== originalText;
                if (hasReplacement) {
                  replyText += "\n\n（由于平台限制，回复中的部分符号已被替换）";
                }

                try {
                  await sendWithTokenRetry(async (token) => {
                    if (event.type === "c2c") {
                      await sendC2CMessage(token, event.senderId, replyText, event.messageId);
                    } else if (event.type === "group" && event.groupOpenid) {
                      await sendGroupMessage(token, event.groupOpenid, replyText, event.messageId);
                    } else if (event.channelId) {
                      await sendChannelMessage(token, event.channelId, replyText, event.messageId);
                    }
                  });
                  log?.info(`[qqbot:${account.accountId}] Sent reply`);

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
                // 发送错误提示给用户
                const errMsg = String(err);
                if (errMsg.includes("401") || errMsg.includes("key") || errMsg.includes("auth")) {
                  await sendErrorMessage("[ClawdBot] 大模型 API Key 可能无效，请检查配置");
                } else {
                  await sendErrorMessage(`[ClawdBot] 处理消息时出错: ${errMsg.slice(0, 100)}`);
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
              await sendErrorMessage("[ClawdBot] 未收到响应，请检查大模型 API Key 是否正确配置");
            }
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message processing failed: ${err}`);
          await sendErrorMessage(`[ClawdBot] 处理消息失败: ${String(err).slice(0, 100)}`);
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
          const payload = JSON.parse(data.toString()) as WSPayload;
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
                ws.send(JSON.stringify({
                  op: 2,
                  d: {
                    token: `QQBot ${accessToken}`,
                    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C,
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
                log?.info(`[qqbot:${account.accountId}] Ready, session: ${sessionId}`);
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
              log?.error(`[qqbot:${account.accountId}] Invalid session, can resume: ${canResume}`);
              if (!canResume) {
                sessionId = null;
                lastSeq = null;
                // 标记需要刷新 token（可能是 token 过期导致的）
                shouldRefreshToken = true;
              }
              cleanup();
              // Invalid Session 后等待一段时间再重连
              scheduleReconnect(5000);
              break;
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message parse error: ${err}`);
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`[qqbot:${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        isConnecting = false; // 释放锁
        
        // 4903 等错误码表示 session 创建失败，需要刷新 token
        if (code === 4903 || code === 4009 || code === 4014) {
          log?.info(`[qqbot:${account.accountId}] Session error (${code}), will refresh token`);
          shouldRefreshToken = true;
          sessionId = null;
          lastSeq = null;
        }
        
        // 检测是否是快速断开（连接后很快就断了）
        const connectionDuration = Date.now() - lastConnectTime;
        if (connectionDuration < QUICK_DISCONNECT_THRESHOLD && lastConnectTime > 0) {
          quickDisconnectCount++;
          log?.info(`[qqbot:${account.accountId}] Quick disconnect detected (${connectionDuration}ms), count: ${quickDisconnectCount}`);
          
          // 如果连续快速断开超过阈值，清除 session 并等待更长时间
          if (quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
            log?.info(`[qqbot:${account.accountId}] Too many quick disconnects, clearing session and refreshing token`);
            sessionId = null;
            lastSeq = null;
            shouldRefreshToken = true;
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
