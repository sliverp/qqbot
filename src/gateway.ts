/**
 * QQ Bot WebSocket Gateway
 * 管理 WebSocket 连接、心跳、会话恢复、消息队列
 * 消息组装和投递逻辑分别在 gateway-inbound.ts 和 gateway-deliver.ts
 */

import WebSocket from "ws";
import type { ResolvedQQBotAccount, WSPayload, C2CMessageEvent, GuildMessageEvent, GroupMessageEvent } from "./types.js";
import { getAccessToken, getGatewayUrl, clearTokenCache, initApiConfig, startBackgroundTokenRefresh, stopBackgroundTokenRefresh, sendC2CInputNotify } from "./api.js";
import { loadSession, saveSession, clearSession } from "./session-store.js";
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { getQQBotRuntime } from "./runtime.js";
import { buildInboundMessage, type InboundMessageEvent } from "./gateway-inbound.js";
import { handleDeliver, type DeliverContext } from "./gateway-deliver.js";
import { withTokenRetry, targetFromEvent, sendTextToTarget } from "./utils/send-target.js";

// QQ Bot intents
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
};

const INTENT_LEVELS = [
  { name: "full", intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C, description: "群聊+私信+频道" },
  { name: "group+channel", intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C, description: "群聊+频道" },
  { name: "channel-only", intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GUILD_MEMBERS, description: "仅频道消息" },
];

// 重连配置
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
const RATE_LIMIT_DELAY = 60000;
const MAX_RECONNECT_ATTEMPTS = 100;
const MAX_QUICK_DISCONNECT_COUNT = 3;
const QUICK_DISCONNECT_THRESHOLD = 5000;

// 消息队列配置
const MESSAGE_QUEUE_SIZE = 1000;
const MESSAGE_QUEUE_WARN_THRESHOLD = 800;

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

  initApiConfig({ markdownSupport: account.markdownSupport });
  log?.info(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport === true}`);

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let lastConnectTime = 0;
  let quickDisconnectCount = 0;
  let isConnecting = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shouldRefreshToken = false;
  let intentLevelIndex = 0;
  let lastSuccessfulIntentLevel = -1;

  // 恢复 Session
  const savedSession = loadSession(account.accountId);
  if (savedSession) {
    sessionId = savedSession.sessionId;
    lastSeq = savedSession.lastSeq;
    intentLevelIndex = savedSession.intentLevelIndex;
    lastSuccessfulIntentLevel = savedSession.intentLevelIndex;
    log?.info(`[qqbot:${account.accountId}] Restored session: sessionId=${sessionId}, lastSeq=${lastSeq}, intentLevel=${intentLevelIndex}`);
  }

  // 消息队列
  const messageQueue: InboundMessageEvent[] = [];
  let messageProcessorRunning = false;

  const enqueueMessage = (msg: InboundMessageEvent): void => {
    if (messageQueue.length >= MESSAGE_QUEUE_SIZE) {
      const dropped = messageQueue.shift();
      log?.error(`[qqbot:${account.accountId}] Message queue full, dropping oldest from ${dropped?.senderId}`);
    }
    if (messageQueue.length >= MESSAGE_QUEUE_WARN_THRESHOLD) {
      log?.info(`[qqbot:${account.accountId}] Message queue size: ${messageQueue.length}/${MESSAGE_QUEUE_SIZE}`);
    }
    messageQueue.push(msg);
  };

  const startMessageProcessor = (handleMessageFn: (msg: InboundMessageEvent) => Promise<void>): void => {
    if (messageProcessorRunning) return;
    messageProcessorRunning = true;

    const processLoop = async () => {
      while (!isAborted) {
        if (messageQueue.length === 0) {
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
        const msg = messageQueue.shift()!;
        try {
          await handleMessageFn(msg);
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message processor error: ${err}`);
        }
      }
      messageProcessorRunning = false;
    };

    processLoop().catch(err => {
      log?.error(`[qqbot:${account.accountId}] Message processor crashed: ${err}`);
      messageProcessorRunning = false;
    });
  };

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    cleanup();
    stopBackgroundTokenRefresh();
    flushKnownUsers();
  });

  const cleanup = () => {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (currentWs && (currentWs.readyState === WebSocket.OPEN || currentWs.readyState === WebSocket.CONNECTING)) {
      currentWs.close();
    }
    currentWs = null;
  };

  const getReconnectDelay = () => RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)];

  const scheduleReconnect = (customDelay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log?.error(`[qqbot:${account.accountId}] Max reconnect attempts reached or aborted`);
      return;
    }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const delay = customDelay ?? getReconnectDelay();
    reconnectAttempts++;
    log?.info(`[qqbot:${account.accountId}] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) connect();
    }, delay);
  };

  const connect = async () => {
    if (isConnecting) return;
    isConnecting = true;

    try {
      cleanup();
      if (shouldRefreshToken) {
        log?.info(`[qqbot:${account.accountId}] Refreshing token...`);
        clearTokenCache();
        shouldRefreshToken = false;
      }

      const accessToken = await getAccessToken(account.appId, account.clientSecret);
      log?.info(`[qqbot:${account.accountId}] Access token obtained`);
      const gatewayUrl = await getGatewayUrl(accessToken);
      log?.info(`[qqbot:${account.accountId}] Connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl);
      currentWs = ws;
      const pluginRuntime = getQQBotRuntime();

      // 消息处理核心
      const handleMessage = async (event: InboundMessageEvent) => {
        log?.info(`[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`);

        pluginRuntime.channel.activity.record({
          channel: "qqbot",
          accountId: account.accountId,
          direction: "inbound",
        });

        try {
          await sendC2CInputNotify(accessToken, event.senderId, event.messageId, 60);
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] sendC2CInputNotify error: ${err}`);
        }

        // 构建入站消息
        const inbound = await buildInboundMessage(event, account, log);

        const peerId = event.type === "guild" ? `channel:${event.channelId}`
                     : event.type === "group" ? `group:${event.groupOpenid}`
                     : event.senderId;

        const route = pluginRuntime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "qqbot",
          accountId: account.accountId,
          peer: {
            kind: inbound.isGroup ? "group" : "dm",
            id: peerId,
          },
        });

        const envelopeOptions = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);

        const body = pluginRuntime.channel.reply.formatInboundEnvelope({
          channel: "qqbot",
          from: event.senderName ?? event.senderId,
          timestamp: new Date(event.timestamp).getTime(),
          body: inbound.userContent,
          chatType: inbound.isGroup ? "group" : "direct",
          sender: { id: event.senderId, name: event.senderName },
          envelope: envelopeOptions,
          ...(inbound.localMediaPaths.length > 0 || inbound.remoteMediaUrls.length > 0
            ? { imageUrls: [...inbound.localMediaPaths, ...inbound.remoteMediaUrls] }
            : {}),
        });

        const toAddress = inbound.fromAddress;

        log?.info(`[qqbot:${account.accountId}] Body: ${body}`);
        log?.info(`[qqbot:${account.accountId}] BodyForAgent: ${inbound.agentBody}`);

        const ctxPayload = pluginRuntime.channel.reply.finalizeInboundContext({
          Body: body,
          BodyForAgent: inbound.agentBody,
          RawBody: event.content,
          CommandBody: event.content,
          From: inbound.fromAddress,
          To: toAddress,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: inbound.isGroup ? "group" : "direct",
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
          CommandAuthorized: inbound.commandAuthorized,
          ...(inbound.localMediaPaths.length > 0 ? {
            MediaPaths: inbound.localMediaPaths,
            MediaPath: inbound.localMediaPaths[0],
            MediaTypes: inbound.localMediaTypes,
            MediaType: inbound.localMediaTypes[0],
          } : {}),
          ...(inbound.remoteMediaUrls.length > 0 ? {
            MediaUrls: inbound.remoteMediaUrls,
            MediaUrl: inbound.remoteMediaUrls[0],
          } : {}),
        });

        // 构建 deliver context
        const deliverCtx: DeliverContext = {
          event: {
            type: event.type,
            senderId: event.senderId,
            messageId: event.messageId,
            channelId: event.channelId,
            groupOpenid: event.groupOpenid,
          },
          account,
          log,
          recordActivity: () => {
            pluginRuntime.channel.activity.record({
              channel: "qqbot",
              accountId: account.accountId,
              direction: "outbound",
            });
          },
        };

        // 发送错误提示辅助
        const sendErrorMessage = async (errorText: string) => {
          try {
            await withTokenRetry(account.appId, account.clientSecret, async (token) => {
              const target = targetFromEvent(deliverCtx.event);
              await sendTextToTarget(token, target, errorText, event.messageId);
            });
          } catch (sendErr) {
            log?.error(`[qqbot:${account.accountId}] Failed to send error message: ${sendErr}`);
          }
        };

        try {
          const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);

          let hasResponse = false;
          const responseTimeout = 60000;
          let timeoutId: ReturnType<typeof setTimeout> | null = null;

          const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
              if (!hasResponse) reject(new Error("Response timeout"));
            }, responseTimeout);
          });

          const dispatchPromise = pluginRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              responsePrefix: messagesConfig.responsePrefix,
              deliver: async (payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }, info: { kind: string }) => {
                hasResponse = true;
                if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }

                log?.info(`[qqbot:${account.accountId}] deliver called, kind: ${info.kind}`);
                await handleDeliver(deliverCtx, payload, info);
              },
              onError: async (err: unknown) => {
                log?.error(`[qqbot:${account.accountId}] Dispatch error: ${err}`);
                hasResponse = true;
                if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
                const errMsg = String(err);
                if (errMsg.includes("401") || errMsg.includes("key") || errMsg.includes("auth")) {
                  await sendErrorMessage("大模型 API Key 可能无效，请检查配置");
                } else {
                  await sendErrorMessage(`出错: ${errMsg.slice(0, 500)}`);
                }
              },
            },
            replyOptions: { disableBlockStreaming: false },
          });

          try {
            await Promise.race([dispatchPromise, timeoutPromise]);
          } catch {
            if (timeoutId) clearTimeout(timeoutId);
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

      // WebSocket 事件处理
      ws.on("open", () => {
        log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
        isConnecting = false;
        reconnectAttempts = 0;
        lastConnectTime = Date.now();
        startMessageProcessor(handleMessage);
        startBackgroundTokenRefresh(account.appId, account.clientSecret, { log: log as { info: (msg: string) => void; error: (msg: string) => void } });
      });

      ws.on("message", async (data) => {
        try {
          const rawData = data.toString();
          const payload = JSON.parse(rawData) as WSPayload;
          const { op, d, s, t } = payload;

          if (s) {
            lastSeq = s;
            if (sessionId) {
              saveSession({
                sessionId, lastSeq,
                lastConnectedAt: lastConnectTime,
                intentLevelIndex: lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex,
                accountId: account.accountId,
                savedAt: Date.now(),
              });
            }
          }

          switch (op) {
            case 10: { // Hello
              if (sessionId && lastSeq !== null) {
                log?.info(`[qqbot:${account.accountId}] Resuming session ${sessionId}`);
                ws.send(JSON.stringify({
                  op: 6,
                  d: { token: `QQBot ${accessToken}`, session_id: sessionId, seq: lastSeq },
                }));
              } else {
                const levelToUse = lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex;
                const intentLevel = INTENT_LEVELS[Math.min(levelToUse, INTENT_LEVELS.length - 1)];
                log?.info(`[qqbot:${account.accountId}] Identify with intents: ${intentLevel.intents} (${intentLevel.description})`);
                ws.send(JSON.stringify({
                  op: 2,
                  d: { token: `QQBot ${accessToken}`, intents: intentLevel.intents, shard: [0, 1] },
                }));
              }

              const interval = (d as { heartbeat_interval: number }).heartbeat_interval;
              if (heartbeatInterval) clearInterval(heartbeatInterval);
              heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ op: 1, d: lastSeq }));
                }
              }, interval);
              break;
            }

            case 0: // Dispatch
              if (t === "READY") {
                const readyData = d as { session_id: string };
                sessionId = readyData.session_id;
                lastSuccessfulIntentLevel = intentLevelIndex;
                log?.info(`[qqbot:${account.accountId}] Ready (${INTENT_LEVELS[intentLevelIndex].description}), session: ${sessionId}`);
                saveSession({ sessionId, lastSeq, lastConnectedAt: Date.now(), intentLevelIndex, accountId: account.accountId, savedAt: Date.now() });
                onReady?.(d);
              } else if (t === "RESUMED") {
                log?.info(`[qqbot:${account.accountId}] Session resumed`);
                if (sessionId) {
                  saveSession({ sessionId, lastSeq, lastConnectedAt: Date.now(), intentLevelIndex: lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex, accountId: account.accountId, savedAt: Date.now() });
                }
              } else if (t === "C2C_MESSAGE_CREATE") {
                const evt = d as C2CMessageEvent;
                recordKnownUser({ openid: evt.author.user_openid, type: "c2c", accountId: account.accountId });
                enqueueMessage({
                  type: "c2c", senderId: evt.author.user_openid, content: evt.content,
                  messageId: evt.id, timestamp: evt.timestamp, attachments: evt.attachments,
                });
              } else if (t === "AT_MESSAGE_CREATE") {
                const evt = d as GuildMessageEvent;
                recordKnownUser({ openid: evt.author.id, type: "c2c", nickname: evt.author.username, accountId: account.accountId });
                enqueueMessage({
                  type: "guild", senderId: evt.author.id, senderName: evt.author.username,
                  content: evt.content, messageId: evt.id, timestamp: evt.timestamp,
                  channelId: evt.channel_id, guildId: evt.guild_id, attachments: evt.attachments,
                });
              } else if (t === "DIRECT_MESSAGE_CREATE") {
                const evt = d as GuildMessageEvent;
                recordKnownUser({ openid: evt.author.id, type: "c2c", nickname: evt.author.username, accountId: account.accountId });
                enqueueMessage({
                  type: "dm", senderId: evt.author.id, senderName: evt.author.username,
                  content: evt.content, messageId: evt.id, timestamp: evt.timestamp,
                  guildId: evt.guild_id, attachments: evt.attachments,
                });
              } else if (t === "GROUP_AT_MESSAGE_CREATE") {
                const evt = d as GroupMessageEvent;
                recordKnownUser({ openid: evt.author.member_openid, type: "group", groupOpenid: evt.group_openid, accountId: account.accountId });
                enqueueMessage({
                  type: "group", senderId: evt.author.member_openid, content: evt.content,
                  messageId: evt.id, timestamp: evt.timestamp, groupOpenid: evt.group_openid,
                  attachments: evt.attachments,
                });
              }
              break;

            case 11: break; // Heartbeat ACK

            case 7: // Reconnect
              log?.info(`[qqbot:${account.accountId}] Server requested reconnect`);
              cleanup();
              scheduleReconnect();
              break;

            case 9: { // Invalid Session
              const canResume = d as boolean;
              log?.error(`[qqbot:${account.accountId}] Invalid session, can resume: ${canResume}`);
              if (!canResume) {
                sessionId = null;
                lastSeq = null;
                clearSession(account.accountId);
                if (intentLevelIndex < INTENT_LEVELS.length - 1) {
                  intentLevelIndex++;
                  log?.info(`[qqbot:${account.accountId}] Downgrading intents to: ${INTENT_LEVELS[intentLevelIndex].description}`);
                } else {
                  log?.error(`[qqbot:${account.accountId}] All intent levels failed`);
                  shouldRefreshToken = true;
                }
              }
              cleanup();
              scheduleReconnect(3000);
              break;
            }
          }
        } catch (err) {
          log?.error(`[qqbot:${account.accountId}] Message parse error: ${err}`);
        }
      });

      ws.on("close", (code, reason) => {
        log?.info(`[qqbot:${account.accountId}] WebSocket closed: ${code} ${reason.toString()}`);
        isConnecting = false;

        // 不可恢复的错误码
        if (code === 4914 || code === 4915) {
          log?.error(`[qqbot:${account.accountId}] Bot is ${code === 4914 ? "offline" : "banned"}`);
          cleanup();
          return;
        }

        if (code === 4004) {
          shouldRefreshToken = true;
          cleanup();
          if (!isAborted) scheduleReconnect();
          return;
        }

        if (code === 4008) {
          cleanup();
          if (!isAborted) scheduleReconnect(RATE_LIMIT_DELAY);
          return;
        }

        if (code === 4006 || code === 4007 || code === 4009) {
          sessionId = null; lastSeq = null;
          clearSession(account.accountId);
          shouldRefreshToken = true;
        } else if (code >= 4900 && code <= 4913) {
          sessionId = null; lastSeq = null;
          clearSession(account.accountId);
          shouldRefreshToken = true;
        }

        // 快速断开检测
        const duration = Date.now() - lastConnectTime;
        if (duration < QUICK_DISCONNECT_THRESHOLD && lastConnectTime > 0) {
          quickDisconnectCount++;
          if (quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
            log?.error(`[qqbot:${account.accountId}] Too many quick disconnects`);
            quickDisconnectCount = 0;
            cleanup();
            if (!isAborted && code !== 1000) scheduleReconnect(RATE_LIMIT_DELAY);
            return;
          }
        } else {
          quickDisconnectCount = 0;
        }

        cleanup();
        if (!isAborted && code !== 1000) scheduleReconnect();
      });

      ws.on("error", (err) => {
        log?.error(`[qqbot:${account.accountId}] WebSocket error: ${err.message}`);
        onError?.(err);
      });

    } catch (err) {
      isConnecting = false;
      const errMsg = String(err);
      log?.error(`[qqbot:${account.accountId}] Connection failed: ${err}`);
      if (errMsg.includes("Too many requests") || errMsg.includes("100001")) {
        scheduleReconnect(RATE_LIMIT_DELAY);
      } else {
        scheduleReconnect();
      }
    }
  };

  await connect();

  return new Promise((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
