import WebSocket from "ws";
import path from "node:path";
import fs from "node:fs";
import type { ResolvedQQBotAccount, WSPayload, C2CMessageEvent, GuildMessageEvent, GroupMessageEvent, InteractionEvent } from "./types.js";
import { getAccessToken, getGatewayUrl, sendC2CMessage, sendChannelMessage, sendGroupMessage, clearTokenCache, initApiConfig, startBackgroundTokenRefresh, stopBackgroundTokenRefresh, sendC2CInputNotify, onMessageSent, PLUGIN_USER_AGENT, sendProactiveGroupMessage, acknowledgeInteraction, getApiPluginVersion } from "./api.js";
import { loadSession, saveSession, clearSession } from "./session-store.js";
import { recordKnownUser, flushKnownUsers } from "./known-users.js";
import { getQQBotRuntime } from "./runtime.js";
import { isGroupAllowed, resolveGroupName, resolveGroupPrompt, resolveHistoryLimit, resolveGroupPolicy, resolveGroupConfig, resolveIgnoreOtherMentions, resolveMentionPatterns } from "./config.js";
import { qqbotPlugin } from "./channel.js";
import {
  recordPendingHistoryEntry,
  buildPendingHistoryContext,
  buildMergedMessageContext,
  clearPendingHistory,
  formatAttachmentTags,
  formatMessageContent,
  toAttachmentSummaries,
  type HistoryEntry,
} from "./group-history.js";

import { setRefIndex, getRefIndex, formatRefEntryForAgent, flushRefIndex, type RefAttachmentSummary } from "./ref-index-store.js";
import { matchSlashCommand, getFrameworkVersion, parseFrameworkDateVersion, type SlashCommandContext, type SlashCommandFileResult } from "./slash-commands.js";
import { createMessageQueue, type QueuedMessage } from "./message-queue.js";
import { triggerUpdateCheck } from "./update-checker.js";
import { startImageServer, isImageServerRunning, type ImageServerConfig } from "./image-server.js";
import { resolveTTSConfig } from "./utils/audio-convert.js";
import { processAttachments, formatVoiceText } from "./inbound-attachments.js";
import { getQQBotDataDir, runDiagnostics } from "./utils/platform.js";

import { sendDocument, sendMedia as sendMediaAuto, type MediaTargetContext } from "./outbound.js";
import { parseFaceTags, parseRefIndices, buildAttachmentSummaries } from "./utils/text-parsing.js";
import { sendStartupGreetings, type AdminResolverContext } from "./admin-resolver.js";
import { sendWithTokenRetry, sendErrorToTarget, handleStructuredPayload, type ReplyContext, type MessageTarget } from "./reply-dispatcher.js";
import { TypingKeepAlive, TYPING_INPUT_SECOND } from "./typing-keepalive.js";
import { parseAndSendMediaTags, sendPlainReply, type DeliverEventContext, type DeliverAccountContext } from "./outbound-deliver.js";
import { createDeliverDebouncer, type DeliverDebouncer } from "./deliver-debounce.js";
import { runWithRequestContext } from "./request-context.js";
import { StreamingController, shouldUseStreaming } from "./streaming.js";
import { resolveGroupMessageGate } from "./message-gating.js";

// ============ Interaction 处理 ============

/** 配置查询交互类型 */
const INTERACTION_TYPE_CONFIG_QUERY = 2001;

/** 配置更新交互类型 */
const INTERACTION_TYPE_CONFIG_UPDATE = 2002;

/** 处理 INTERACTION_CREATE 事件 */
async function handleInteractionCreate(params: {
  event: InteractionEvent;
  account: ResolvedQQBotAccount;
  cfg: unknown;
  log?: { info: (msg: string) => void; warn?: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void };
}): Promise<void> {
  const { event, account, cfg, log } = params;
  const token = await getAccessToken(account.appId, account.clientSecret);

  if (event.data?.type === INTERACTION_TYPE_CONFIG_QUERY) {
    // 从框架 configApi 读取最新配置（而非闭包中的旧 cfg），确保配置查询返回的数据与磁盘一致
    const runtime = getQQBotRuntime();
    const configApi = runtime.config as {
      loadConfig: () => Record<string, unknown>;
      writeConfigFile: (cfg: unknown) => Promise<void>;
    };
    const latestCfg = configApi.loadConfig() as Record<string, unknown>;

    const groupOpenid = event.group_openid ?? "";
    const groupCfg = groupOpenid ? resolveGroupConfig(latestCfg as any, groupOpenid, account.accountId) : null;
    const groupPolicy = resolveGroupPolicy(latestCfg as any, account.accountId);
    // require_mention 协议：字符串 "mention" | "always"（mention=@机器人时激活，always=总是激活）
    const configRequireMention = groupCfg?.requireMention ?? true;
    const requireMentionMode: GroupActivationMode = configRequireMention ? "mention" : "always";
    const pluginVersion = getApiPluginVersion();
    const fwVersionRaw = getFrameworkVersion();
    const clawVer = parseFrameworkDateVersion(fwVersionRaw) ?? fwVersionRaw;

    // 通过路由解析 agentId（与消息处理流程一致），用于 agent-aware 的 mentionPatterns
    const interactionAgentId = groupOpenid
      ? (runtime.channel?.routing?.resolveAgentRoute?.({
          cfg: latestCfg,
          channel: "qqbot",
          accountId: account.accountId,
          peer: { kind: "group", id: groupOpenid },
        }) as { agentId?: string } | undefined)?.agentId
      : undefined;

    // mention_patterns 协议：逗号分隔的字符串（@文本的名称提及BOT名，多个使用,分隔）
    const mentionPatternsArr: string[] = resolveMentionPatterns(latestCfg as any, interactionAgentId);
    const mentionPatterns = mentionPatternsArr.join(",");

    const clawCfg = {
      channel_type: "qqbot",
      channel_ver: pluginVersion,
      claw_type: "openclaw",
      claw_ver: clawVer,
      require_mention: requireMentionMode,
      group_policy: groupPolicy,
      mention_patterns: mentionPatterns,
      online_state: "online",
    };

    await acknowledgeInteraction(token, event.id, 0, { claw_cfg: clawCfg });
    log?.info(`[qqbot:${account.accountId}] Interaction ACK (type=${INTERACTION_TYPE_CONFIG_QUERY}) sent: ${event.id}, claw_cfg=${JSON.stringify(clawCfg)}`);
  } else if (event.data?.type === INTERACTION_TYPE_CONFIG_UPDATE) {
    // type=2002: 配置更新交互，从 resolved.claw_cfg 获取更新信息并写入本地配置
    const resolved = event.data.resolved;
    const clawCfgUpdate = (resolved as Record<string, unknown>)?.claw_cfg as Record<string, unknown> | undefined;
    const groupOpenid = event.group_openid ?? "";

    const runtime = getQQBotRuntime();
    const configApi = runtime.config as {
      loadConfig: () => Record<string, unknown>;
      writeConfigFile: (cfg: unknown) => Promise<void>;
    };

    const currentCfg = structuredClone(configApi.loadConfig()) as Record<string, unknown>;
    const qqbot = ((currentCfg.channels ?? {}) as Record<string, unknown>).qqbot as Record<string, unknown> | undefined;

    let changed = false;

    if (clawCfgUpdate) {
      // 更新 require_mention（群级别）——协议为 "mention" | "always"，写回配置时转为 boolean
      if (clawCfgUpdate.require_mention !== undefined && groupOpenid && qqbot) {
        const requireMentionBool = clawCfgUpdate.require_mention === "mention";
        const accountId = account.accountId;
        const isNamedAccount = accountId !== "default" && (qqbot.accounts as Record<string, Record<string, unknown>> | undefined)?.[accountId];

        if (isNamedAccount) {
          const accounts = qqbot.accounts as Record<string, Record<string, unknown>>;
          const acct = accounts[accountId] ?? {};
          const groups = (acct.groups ?? {}) as Record<string, Record<string, unknown>>;
          groups[groupOpenid] = { ...groups[groupOpenid], requireMention: requireMentionBool };
          acct.groups = groups;
          accounts[accountId] = acct;
          qqbot.accounts = accounts;
        } else {
          const groups = (qqbot.groups ?? {}) as Record<string, Record<string, unknown>>;
          groups[groupOpenid] = { ...groups[groupOpenid], requireMention: requireMentionBool };
          qqbot.groups = groups;
        }
        changed = true;
      }
    }

    if (changed) {
      await configApi.writeConfigFile(currentCfg);
      log?.info(`[qqbot:${account.accountId}] Config updated via interaction ${event.id}: ${JSON.stringify({
        require_mention: clawCfgUpdate?.require_mention,
        group_openid: groupOpenid || undefined,
      })}`);
    }

    // 无论更新是否成功，ACK 都上报最新的 claw_cfg 快照（写入后重新读取确保一致）
    const latestCfg = changed ? (configApi.loadConfig() as Record<string, unknown>) : currentCfg;
    const updatedGroupCfg = groupOpenid ? resolveGroupConfig(latestCfg as any, groupOpenid, account.accountId) : null;
    const updatedRequireMention = updatedGroupCfg?.requireMention ?? true;
    const updatedRequireMentionMode: GroupActivationMode = updatedRequireMention ? "mention" : "always";
    const pluginVersion = getApiPluginVersion();
    const fwVersionRaw = getFrameworkVersion();
    const clawVer = parseFrameworkDateVersion(fwVersionRaw) ?? fwVersionRaw;

    const ackClawCfg = {
      channel_type: "qqbot",
      channel_ver: pluginVersion,
      claw_type: "openclaw",
      claw_ver: clawVer,
      require_mention: updatedRequireMentionMode,
      online_state: "online",
    };

    await acknowledgeInteraction(token, event.id, 0, { claw_cfg: ackClawCfg });
    log?.info(`[qqbot:${account.accountId}] Interaction ACK (type=${INTERACTION_TYPE_CONFIG_UPDATE}) sent: ${event.id}, claw_cfg=${JSON.stringify(ackClawCfg)}`);
  } else {
    // 其他类型：普通 ACK
    await acknowledgeInteraction(token, event.id);
    log?.debug?.(`[qqbot:${account.accountId}] Interaction ACK sent: ${event.id}`);
  }
}

// /activation 命令支持：读取 session store 中的 groupActivation 值
// plugin-sdk 未导出 loadSessionStore，插件侧内联实现（只读）

type GroupActivationMode = "mention" | "always";

/** 解析 session store 文件路径 */
function resolveSessionStorePath(cfg: Record<string, unknown>, agentId?: string): string {
  const sessionCfg = (cfg as any)?.session;
  const store: string | undefined = sessionCfg?.store;
  const resolvedAgentId = agentId || "default";

  if (store) {
    let expanded = store;
    if (expanded.includes("{agentId}")) {
      expanded = expanded.replaceAll("{agentId}", resolvedAgentId);
    }
    if (expanded.startsWith("~")) {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      expanded = expanded.replace(/^~/, home);
    }
    return path.resolve(expanded);
  }

  // 默认路径: ~/.openclaw/agents/{agentId}/sessions/sessions.json
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim()
    || process.env.CLAWDBOT_STATE_DIR?.trim()
    || path.join(process.env.HOME || process.env.USERPROFILE || "", ".openclaw");
  return path.join(stateDir, "agents", resolvedAgentId, "sessions", "sessions.json");
}

// ============ Mention Gating — 已抽取到 message-gating.ts ============

// ============ Command Detection（委托框架运行时 commands-registry） ============

/**
 * 检测消息是否包含框架控制命令（如 /activation、/status 等）。
 *
 * 不再使用静态 KNOWN_CONTROL_COMMANDS 列表，而是委托给框架运行时
 * pluginRuntime.channel.text.hasControlCommand()，确保框架新增命令时
 * 无需手动同步。
 *
 * 如果 pluginRuntime 尚未初始化（极端边界），回退到简单的 "/" 前缀检测。
 */
function hasControlCommand(text: string): boolean {
  if (!text || !text.startsWith("/")) return false;
  try {
    const runtime = getQQBotRuntime();
    const runtimeHasControlCommand = runtime?.channel?.text?.hasControlCommand;
    if (typeof runtimeHasControlCommand === "function") {
      return runtimeHasControlCommand(text);
    }
  } catch {
    // runtime 未初始化，fallback
  }
  // fallback：简单的 "/" + word 检测（宁可误判为 true 也不漏掉命令）
  return /^\/[a-z][a-z0-9_-]*/i.test(text);
}

// ============ Text Command Gating ============

/**
 * 判断文本命令是否启用。
 * 当 cfg.commands.text === false 时禁用；QQ Bot 仅支持文本命令（无 native slash command）。
 */
function shouldHandleTextCommands(cfg: Record<string, unknown>): boolean {
  const commands = cfg.commands as { text?: boolean } | undefined;
  // 仅当显式设置为 false 时禁用（默认启用）
  return commands?.text !== false;
}

// ============ hasAnyMention 检测 ============

/**
 * 检测消息中是否包含任何 @mention（不限于 @bot）。
 * 如果消息 @ 了任何人，即使是控制命令也不应该 bypass mention 门控。
 */
function hasAnyMention(params: {
  mentions?: Array<{ is_you?: boolean; bot?: boolean; [key: string]: unknown }>;
  content?: string;
}): boolean {
  // QQ 事件中 mentions 数组包含了消息中所有被 @ 的用户（含 bot）
  if (params.mentions && params.mentions.length > 0) return true;
  // 兜底：检查文本中是否有 <@xxx> 格式的 mention
  if (params.content && /<@!?\w+>/.test(params.content)) return true;
  return false;
}

// ============ implicitMention 检测 ============

/**
 * 检测引用回复是否构成隐式 mention。
 * 如果用户回复的是 bot 发出的消息，视为隐式 mention。
 */
function resolveImplicitMention(params: {
  refMsgIdx?: string;
  getRefEntry: (idx: string) => { isBot?: boolean } | null;
}): boolean {
  if (!params.refMsgIdx) return false;
  const refEntry = params.getRefEntry(params.refMsgIdx);
  return refEntry?.isBot === true;
}

/**
 * 解析 groupActivation（session store > 配置 requireMention > 默认值）
 * @returns "mention" | "always"
 */
function resolveGroupActivation(params: {
  cfg: Record<string, unknown>;
  agentId: string;
  sessionKey: string;
  configRequireMention: boolean;
}): GroupActivationMode {
  const defaultActivation: GroupActivationMode = params.configRequireMention ? "mention" : "always";

  try {
    const storePath = resolveSessionStorePath(params.cfg, params.agentId);
    if (!fs.existsSync(storePath)) {
      return defaultActivation;
    }
    const raw = fs.readFileSync(storePath, "utf-8");
    const store = JSON.parse(raw) as Record<string, { groupActivation?: string }>;
    const entry = store[params.sessionKey];
    if (!entry?.groupActivation) {
      return defaultActivation;
    }
    const normalized = entry.groupActivation.trim().toLowerCase();
    if (normalized === "mention" || normalized === "always") {
      return normalized;
    }
    return defaultActivation;
  } catch {
    // session store 读取失败时 fallback 到配置文件
    return defaultActivation;
  }
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
  INTERACTION: 1 << 26,              // 按钮交互回调
};

// 固定使用完整权限（群聊 + 私信 + 频道 + 交互），不做降级
const FULL_INTENTS = INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION;
const FULL_INTENTS_DESC = "群聊+私信+频道+交互";

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

// 模块级变量：per-account 首次 READY 跟踪
// 区分 gateway restart（进程重启）和 health-monitor 断线重连
// 每个 account 首次 READY/RESUMED 时从 Set 中移除，之后不再发送问候语
const _pendingFirstReady = new Set<string>();

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

  // 预检 openclaw runtime 模块是否可正常解析（兼容性诊断）
  // openclaw 3.23+ 存在 plugin-sdk/root-alias.cjs 回归 bug，
  // 内置插件（qwen-portal-auth 等）全部加载失败，导致 AI agent 调用返回
  // "Unable to resolve plugin runtime module"。提前检测并告警。
  try {
    const pluginRuntime = getQQBotRuntime();
    if (pluginRuntime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
      log?.info(`[qqbot:${account.accountId}] Runtime module preflight: OK`);
    } else {
      log?.error(`[qqbot:${account.accountId}] ⚠️ Runtime preflight: dispatchReply API 不可用，AI 消息处理可能失败。请检查 openclaw 版本兼容性`);
    }
  } catch (preflightErr) {
    log?.error(`[qqbot:${account.accountId}] ⚠️ Runtime preflight failed: ${preflightErr}. AI 消息处理可能失败`);
  }

  // 后台版本检查（供 /bot-version、/bot-upgrade 指令被动查询）
  triggerUpdateCheck(log);

  // 初始化 API 配置（markdown 支持）
  initApiConfig({
    markdownSupport: account.markdownSupport,
  });
  log?.info(`[qqbot:${account.accountId}] API config: markdownSupport=${account.markdownSupport === true}`);

  // 注册出站消息 refIdx 缓存钩子
  // 所有消息发送函数在拿到 QQ 回包后，如果含 ref_idx 则自动回调此处缓存
  onMessageSent((refIdx, meta) => {
    log?.info(`[qqbot:${account.accountId}] onMessageSent called: refIdx=${refIdx}, mediaType=${meta.mediaType}, ttsText=${meta.ttsText?.slice(0, 30)}`);
    const attachments: RefAttachmentSummary[] = [];
    if (meta.mediaType) {
      const localPath = meta.mediaLocalPath;
      // filename 取路径的 basename，如果没有路径信息则留空
      const filename = localPath ? path.basename(localPath) : undefined;
      const attachment: RefAttachmentSummary = {
        type: meta.mediaType,
        ...(localPath ? { localPath } : {}),
        ...(filename ? { filename } : {}),
        ...(meta.mediaUrl ? { url: meta.mediaUrl } : {}),
      };
      // 如果是语音消息且有 TTS 原文本，保存到 transcript 并标记来源为 tts
      if (meta.mediaType === "voice" && meta.ttsText) {
        attachment.transcript = meta.ttsText;
        attachment.transcriptSource = "tts";
        log?.info(`[qqbot:${account.accountId}] Saving voice transcript (TTS): ${meta.ttsText.slice(0, 50)}`);
      }
      attachments.push(attachment);
    }
    setRefIndex(refIdx, {
      content: meta.text ?? "",
      senderId: account.accountId,
      senderName: account.accountId,
      timestamp: Date.now(),
      isBot: true,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    log?.info(`[qqbot:${account.accountId}] Cached outbound refIdx: ${refIdx}, attachments=${JSON.stringify(attachments)}`);
  });

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
  // 标记此 account 为待发问候（进程重启时 Set 里已有，断线重连不会重新加入）
  _pendingFirstReady.add(account.accountId);

  const adminCtx: AdminResolverContext = { accountId: account.accountId, appId: account.appId, clientSecret: account.clientSecret, log };

  // ============ P1-2: 尝试从持久化存储恢复 Session ============
  // 传入当前 appId，如果 appId 已变更（换了机器人），旧 session 自动失效
  const savedSession = loadSession(account.accountId, account.appId);
  if (savedSession) {
    sessionId = savedSession.sessionId;
    lastSeq = savedSession.lastSeq;
    log?.info(`[qqbot:${account.accountId}] Restored session from storage: sessionId=${sessionId}, lastSeq=${lastSeq}`);
  }

  // ============ 消息队列（复用 createMessageQueue，内置群消息合并/淘汰策略） ============
  const msgQueue = createMessageQueue({
    accountId: account.accountId,
    log,
    isAborted: () => isAborted,
  });

  // 斜杠指令拦截：在入队前匹配插件级指令，命中则直接回复，不入队
  // 紧急命令列表：这些命令会立即执行，不进入斜杠匹配流程
  const URGENT_COMMANDS = ["/stop"];

  const trySlashCommandOrEnqueue = async (msg: QueuedMessage): Promise<void> => {
    const content = (msg.content ?? "").trim();
    if (!content.startsWith("/")) {
      msgQueue.enqueue(msg);
      return;
    }

    // 检测是否为紧急命令 — 立即执行，清空该用户队列
    const contentLower = content.toLowerCase();
    const isUrgentCommand = URGENT_COMMANDS.some(cmd => contentLower.startsWith(cmd.toLowerCase()));
    if (isUrgentCommand) {
      log?.info(`[qqbot:${account.accountId}] Urgent command detected: ${content.slice(0, 20)}, executing immediately`);
      const peerId = msgQueue.getMessagePeerId(msg);
      const droppedCount = msgQueue.clearUserQueue(peerId);
      if (droppedCount > 0) {
        log?.info(`[qqbot:${account.accountId}] Dropped ${droppedCount} queued messages for ${peerId} due to urgent command`);
      }
      msgQueue.executeImmediate(msg);
      return;
    }

    const receivedAt = Date.now();
    const peerId = msgQueue.getMessagePeerId(msg);

    const cmdCtx: SlashCommandContext = {
      type: msg.type,
      senderId: msg.senderId,
      senderName: msg.senderName,
      messageId: msg.messageId,
      eventTimestamp: msg.timestamp,
      receivedAt,
      rawContent: content,
      args: "",
      channelId: msg.channelId,
      groupOpenid: msg.groupOpenid,
      accountId: account.accountId,
      appId: account.appId,
      accountConfig: account.config,
      queueSnapshot: msgQueue.getSnapshot(peerId),
    };

    try {
      const reply = await matchSlashCommand(cmdCtx);
      if (reply === null) {
        // 不是插件级指令，正常入队交给框架
        msgQueue.enqueue(msg);
        return;
      }

      // 命中插件级指令，直接回复
      log?.info(`[qqbot:${account.accountId}] Slash command matched: ${content}, replying directly`);
      const token = await getAccessToken(account.appId, account.clientSecret);

      // 解析回复：纯文本 or 带文件的结果
      const isFileResult = typeof reply === "object" && reply !== null && "filePath" in reply;
      const replyText = isFileResult ? (reply as SlashCommandFileResult).text : reply as string;
      const replyFile = isFileResult ? (reply as SlashCommandFileResult).filePath : null;

      // 先发送文本回复
      if (msg.type === "c2c") {
        await sendC2CMessage(token, msg.senderId, replyText, msg.messageId);
      } else if (msg.type === "group" && msg.groupOpenid) {
        await sendGroupMessage(token, msg.groupOpenid, replyText, msg.messageId);
      } else if (msg.channelId) {
        await sendChannelMessage(token, msg.channelId, replyText, msg.messageId);
      } else if (msg.type === "dm") {
        await sendC2CMessage(token, msg.senderId, replyText, msg.messageId);
      }

      // 如果有文件需要发送
      if (replyFile) {
        try {
          const targetType = msg.type === "group" ? "group" : msg.type === "c2c" || msg.type === "dm" ? "c2c" : "channel";
          const targetId = msg.type === "group" ? (msg.groupOpenid || msg.senderId) : msg.type === "c2c" || msg.type === "dm" ? msg.senderId : (msg.channelId || msg.senderId);
          const mediaCtx: MediaTargetContext = {
            targetType,
            targetId,
            account,
            replyToId: msg.messageId,
            logPrefix: `[qqbot:${account.accountId}]`,
          };
          await sendDocument(mediaCtx, replyFile);
          log?.info(`[qqbot:${account.accountId}] Slash command file sent: ${replyFile}`);
        } catch (fileErr) {
          log?.error(`[qqbot:${account.accountId}] Failed to send slash command file: ${fileErr}`);
        }
      }
    } catch (err) {
      log?.error(`[qqbot:${account.accountId}] Slash command error: ${err}`);
      // 出错时回退到正常入队
      msgQueue.enqueue(msg);
    }
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

      const ws = new WebSocket(gatewayUrl, { headers: { "User-Agent": PLUGIN_USER_AGENT } });
      currentWs = ws;

      const pluginRuntime = getQQBotRuntime();

      // 群历史消息缓存：非@消息写入此 Map，被@时一次性注入上下文后清空
      const groupHistories = new Map<string, HistoryEntry[]>();

      // 处理收到的消息
      const handleMessage = async (event: {
        type: "c2c" | "guild" | "dm" | "group";
        senderId: string;
        senderName?: string;
        senderIsBot?: boolean;
        content: string;
        messageId: string;
        timestamp: string;
        channelId?: string;
        guildId?: string;
        groupOpenid?: string;
        attachments?: Array<{ content_type: string; url: string; filename?: string; voice_wav_url?: string; asr_refer_text?: string }>;
        refMsgIdx?: string;
        msgIdx?: string;
        eventType?: string;
        mentions?: Array<{ scope?: "all" | "single"; id?: string; user_openid?: string; member_openid?: string; username?: string; bot?: boolean; is_you?: boolean }>;
        messageScene?: { source?: string; ext?: string[] };
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

        // 发送输入状态提示 + 启动自动续期（仅 C2C 私聊有效）
        // refIdx 通过 Promise 延迟获取，在真正需要时再 await
        const isC2C = event.type === "c2c" || event.type === "dm";
        // 用对象包装避免 TS 控制流分析将 null 初始值窄化为 never
        const typing: { keepAlive: TypingKeepAlive | null } = { keepAlive: null };

        const inputNotifyPromise: Promise<string | undefined> = (async () => {
          if (!isC2C) return undefined;
          try {
            let token = await getAccessToken(account.appId, account.clientSecret);
            try {
              const notifyResponse = await sendC2CInputNotify(token, event.senderId, event.messageId, TYPING_INPUT_SECOND);
              log?.info(`[qqbot:${account.accountId}] Sent input notify to ${event.senderId}${notifyResponse.refIdx ? `, got refIdx=${notifyResponse.refIdx}` : ""}`);
              // 首次成功后启动定时续期
              typing.keepAlive = new TypingKeepAlive(
                () => getAccessToken(account.appId, account.clientSecret),
                () => clearTokenCache(account.appId),
                event.senderId,
                event.messageId,
                log,
                `[qqbot:${account.accountId}]`,
              );
              typing.keepAlive.start();
              return notifyResponse.refIdx;
            } catch (notifyErr) {
              const errMsg = String(notifyErr);
              if (errMsg.includes("token") || errMsg.includes("401") || errMsg.includes("11244")) {
                log?.info(`[qqbot:${account.accountId}] InputNotify token expired, refreshing...`);
                clearTokenCache(account.appId);
                token = await getAccessToken(account.appId, account.clientSecret);
                const notifyResponse = await sendC2CInputNotify(token, event.senderId, event.messageId, TYPING_INPUT_SECOND);
                typing.keepAlive = new TypingKeepAlive(
                  () => getAccessToken(account.appId, account.clientSecret),
                  () => clearTokenCache(account.appId),
                  event.senderId,
                  event.messageId,
                  log,
                  `[qqbot:${account.accountId}]`,
                );
                typing.keepAlive.start();
                return notifyResponse.refIdx;
              } else {
                throw notifyErr;
              }
            }
          } catch (err) {
            log?.error(`[qqbot:${account.accountId}] sendC2CInputNotify error: ${err}`);
            return undefined;
          }
        })();

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
        // 静态系统提示已移至 skills/qqbot-remind/SKILL.md 和 skills/qqbot-media/SKILL.md
        // BodyForAgent 只保留必要的动态上下文信息
        
        // ============ 用户标识信息 ============
        
        // 收集额外的系统提示（如果配置了账户级别的 systemPrompt）
        const systemPrompts: string[] = [];
        if (account.systemPrompt) {
          systemPrompts.push(account.systemPrompt);
        }
        
        // 处理附件（图片等）- 下载到本地供 openclaw 访问
        const processed = await processAttachments(event.attachments, { appId: account.appId, peerId, cfg, log });
        const { attachmentInfo, imageUrls, imageMediaTypes, voiceAttachmentPaths, voiceAttachmentUrls, voiceAsrReferTexts, voiceTranscripts, voiceTranscriptSources, attachmentLocalPaths } = processed;
        
        // 语音转录文本注入到用户消息中
        const voiceText = formatVoiceText(voiceTranscripts);
        const hasAsrReferFallback = voiceTranscriptSources.includes("asr");

        // 解析 QQ 表情标签，将 <faceType=...,ext="base64"> 替换为 【表情: 中文名】
        const parsedContent = parseFaceTags(event.content);
        let userContent = voiceText
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
            // 缓存未命中时 replyToBody 为空，AI 只能知道"用户引用了一条消息"
          }
        }

        // 2. 缓存当前消息自身的 msgIdx（供将来被引用时查找）
        // 优先使用推送事件中的 msgIdx（来自 message_scene.ext），否则使用 InputNotify 返回的 refIdx
        // inputNotifyPromise 在这里才 await，此时附件下载等工作已并行完成
        const inputNotifyRefIdx = await inputNotifyPromise;
        const currentMsgIdx = event.msgIdx ?? inputNotifyRefIdx;
        if (currentMsgIdx) {
          const attSummaries = buildAttachmentSummaries(event.attachments, attachmentLocalPaths);
          // 如果有语音转录,把转录文本和来源写入对应附件摘要
          if (attSummaries && voiceTranscripts.length > 0) {
            let voiceIdx = 0;
            for (const att of attSummaries) {
              if (att.type === "voice" && voiceIdx < voiceTranscripts.length) {
                att.transcript = voiceTranscripts[voiceIdx];
                // 保存转录来源
                if (voiceIdx < voiceTranscriptSources.length) {
                  att.transcriptSource = voiceTranscriptSources[voiceIdx];
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
          log?.info(`[qqbot:${account.accountId}] Cached msgIdx=${currentMsgIdx} for future reference (source: ${event.msgIdx ? "message_scene.ext" : "InputNotify"})`);
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
        // AI 看到的投递地址必须带完整前缀（qqbot:c2c: / qqbot:group:）
        const qualifiedTarget = isGroupChat ? `qqbot:group:${event.groupOpenid}` : `qqbot:c2c:${event.senderId}`;

        // 动态检测 TTS 配置状态
        const hasTTS = !!resolveTTSConfig(cfg as Record<string, unknown>);

        // 引用消息上下文
        let quotePart = "";
        if (replyToIsQuote) {
          if (replyToBody) {
            quotePart = `[引用消息开始]\n${replyToBody}\n[引用消息结束]\n`;
          } else {
            quotePart = `[引用消息开始]\n原始内容不可用\n[引用消息结束]\n`;
          }
        }

        // ============ 构建 contextInfo（静态/动态分离） ============
        // 设计原则：
        //   - 静态指引：每条消息不变的内容（场景锚定、投递地址、能力说明），
        //     注入 systemPrompts 前部，session 中虽重复出现但 AI 会自动降权，
        //     且保证长 session 窗口截断后仍可见。
        //   - 动态标签：每条消息变化的数据（时间、附件、ASR），
        //     以紧凑的 [ctx] 块标注在用户消息前，最小化 token 开销。

        // --- 静态指引（仅注入框架信封未覆盖的 QQBot 特有信息） ---
        // 框架 formatInboundEnvelope 已提供：平台标识、发送者、时间戳
        // 投递地址通过 AsyncLocalStorage 请求上下文传递给 remind 工具，无需在 agentBody 中暴露
        const staticParts: string[] = [];
        // TTS 能力声明：仅在启用时告知 AI 可以发语音（媒体标签用法由 qqbot-media SKILL.md 提供）
        // STT 无需声明：转写结果已在动态上下文的 ASR 行中，AI 自然可见
        if (hasTTS) staticParts.push("语音合成已启用");

        // 仅在有静态指引时注入 systemPrompts
        if (staticParts.length > 0) {
          const staticInstruction = staticParts.join(" | ");
          systemPrompts.unshift(staticInstruction);
        }

        // --- 动态上下文 ---
        const dynLines: string[] = [];
        if (imageUrls.length > 0) {
          dynLines.push(`- 图片: ${imageUrls.join(", ")}`);
        }
        if (uniqueVoicePaths.length > 0 || uniqueVoiceUrls.length > 0) {
          dynLines.push(`- 语音: ${[...uniqueVoicePaths, ...uniqueVoiceUrls].join(", ")}`);
        }
        if (uniqueVoiceAsrReferTexts.length > 0) {
          dynLines.push(`- ASR: ${uniqueVoiceAsrReferTexts.join(" | ")}`);
        }
        const dynamicCtx = dynLines.length > 0 ? dynLines.join("\n") + "\n\n" : "";

        // --- 命令授权（所有消息类型共用，群消息门控也需要） ---
        // allowFrom: ["*"] 表示允许所有人，否则检查 senderId 是否在 allowFrom 列表中
        const allowFromList = account.config?.allowFrom ?? [];
        const allowAll = allowFromList.length === 0 || allowFromList.some((entry: string) => entry === "*");
        const commandAuthorized = allowAll || allowFromList.some((entry: string) =>
          entry.toUpperCase() === event.senderId.toUpperCase()
        );

        // --- 群消息上下文：插件只提供策略，框架自动组装 hint ---
        let groupSystemPrompt = "";
        let wasMentioned = false;
        let groupSubject = "";
        let senderLabel = "";

        if (event.type === "group" && event.groupOpenid) {
          // 1. 群策略检查（直接用 config 工具函数，与 Discord 的 allow-list.ts 同理）
          if (!isGroupAllowed(cfg as any, event.groupOpenid, account.accountId)) {
            log?.info(`[qqbot:${account.accountId}] Group ${event.groupOpenid} not allowed by groupPolicy, skipping`);
            return;
          }

          // 2. @检测（委托 mentions 适配器）
          const mentionPatternsForDetect: string[] = resolveMentionPatterns(cfg as any, route.agentId);
          wasMentioned = qqbotPlugin.mentions?.detectWasMentioned?.({
            eventType: event.eventType,
            mentions: event.mentions,
            content: event.content,
            mentionPatterns: mentionPatternsForDetect,
          }) ?? false;

          // 3. requireMention 门控
          // 优先级：session store 中的 /activation 命令 > 配置文件 requireMention > 默认值
          // 未被 @ 时：消息仍写入上下文（让 bot 拥有完整对话记忆），但不触发 AI 回复
          const configRequireMention = qqbotPlugin.groups?.resolveRequireMention?.({
            cfg: cfg as any,
            accountId: account.accountId,
            groupId: event.groupOpenid,
          }) ?? true;

          const activation = resolveGroupActivation({
            cfg: cfg as any,
            agentId: route.agentId,
            sessionKey: route.sessionKey,
            configRequireMention,
          });
          const requireMention = activation === "mention";

          // 4. 隐式 mention：引用回复 bot 的消息视为隐式 mention
          const implicitMention = resolveImplicitMention({
            refMsgIdx: event.refMsgIdx,
            getRefEntry: getRefIndex,
          });

          // 4.5 统一门控：ignoreOtherMentions → shouldBlock → mention 门控
          // 三层判断收敛到 resolveGroupMessageGate()
          const contentForCommand = event.content?.trim() ?? "";
          const allowTextCommands = shouldHandleTextCommands(cfg as Record<string, unknown>);
          const gate = resolveGroupMessageGate({
            ignoreOtherMentions: resolveIgnoreOtherMentions(cfg as any, event.groupOpenid, account.accountId),
            hasAnyMention: hasAnyMention({ mentions: event.mentions, content: event.content }),
            wasMentioned,
            implicitMention,
            allowTextCommands,
            isControlCommand: hasControlCommand(contentForCommand),
            commandAuthorized,
            requireMention,
            canDetectMention: true,
          });

          if (gate.action === "drop_other_mention") {
            // @了其他人但未 @bot：记录历史后丢弃
            const historyLimit = resolveHistoryLimit(cfg as any, event.groupOpenid, account.accountId);
            const senderForHistory = event.senderName
              ? `${event.senderName} (${event.senderId})`
              : event.senderId;
            const historyAttachments = toAttachmentSummaries(event.attachments);
            recordPendingHistoryEntry({
              historyMap: groupHistories,
              historyKey: event.groupOpenid,
              limit: historyLimit,
              entry: {
                sender: senderForHistory,
                body: event.content,
                timestamp: new Date(event.timestamp).getTime(),
                messageId: event.messageId,
                attachments: historyAttachments,
              },
            });
            log?.info(`[qqbot:${account.accountId}] Group ${event.groupOpenid}: drop message (ignoreOtherMentions=true, other user mentioned, bot not mentioned)`);
            return;
          }

          if (gate.action === "block_unauthorized_command") {
            // 未授权控制命令：静默拦截，不交给 AI
            log?.info(`[qqbot:${account.accountId}] Group ${event.groupOpenid}: blocked unauthorized control command from ${event.senderId}: ${contentForCommand.slice(0, 50)}`);
            return;
          }

          if (gate.action === "skip_no_mention") {
            // 非 @bot 消息：记录到群历史缓存后跳过 AI
            const historyLimit = resolveHistoryLimit(cfg as any, event.groupOpenid, account.accountId);
            const senderForHistory = event.senderName
              ? `${event.senderName} (${event.senderId})`
              : event.senderId;
            const historyAttachments = toAttachmentSummaries(event.attachments);
            recordPendingHistoryEntry({
              historyMap: groupHistories,
              historyKey: event.groupOpenid,
              limit: historyLimit,
              entry: {
                sender: senderForHistory,
                body: event.content,
                timestamp: new Date(event.timestamp).getTime(),
                messageId: event.messageId,
                attachments: historyAttachments,
              },
            });
            log?.info(`[qqbot:${account.accountId}] Group ${event.groupOpenid}: activation=${activation} (configRequireMention=${configRequireMention}) not mentioned, recorded to history (limit=${historyLimit}, cached=${(groupHistories.get(event.groupOpenid) ?? []).length}${historyAttachments ? `, attachments=${historyAttachments.length}` : ""})`);
            return;
          }

          // gate.action === "pass" — 更新 wasMentioned 为 effectiveWasMentioned（含 implicit + bypass）
          wasMentioned = gate.effectiveWasMentioned;

          // 5. 发送者标签
          senderLabel = event.senderName
            ? `${event.senderName} (${event.senderId})`
            : event.senderId;

          // 6. 群名称（从 config 中读取，fallback 为 openid 前 8 位）
          groupSubject = resolveGroupName(cfg as any, event.groupOpenid, account.accountId);

          // 7. GroupSystemPrompt — 根据消息来源（机器人/人类）和 @状态 注入差异化 PE
          //    基础提示从 resolveGroupIntroHint 获取（群名称、平台限制等静态信息），
          //    然后根据运行时状态追加针对性行为指引。
          const baseHint = qqbotPlugin.groups?.resolveGroupIntroHint?.({
            cfg: cfg as any,
            accountId: account.accountId,
            groupId: event.groupOpenid,
          }) ?? "";

          let behaviorPrompt = "";

          // 从配置读取群行为 PE
          behaviorPrompt = resolveGroupPrompt(cfg as any, event.groupOpenid, account.accountId);

          groupSystemPrompt = [baseHint, behaviorPrompt].filter(Boolean).join("\n");
        }

        const mergedCount = (event as QueuedMessage)._mergedCount;

        // 将 <@member_openid> 替换为 @username（使用 mentions 适配器）
        if (event.type === "group" && event.mentions?.length) {
          userContent = qqbotPlugin.mentions?.stripMentionText?.(userContent, event.mentions as any) ?? userContent;
        } else if (event.mentions?.length) {
          for (const m of event.mentions) {
            if (m.member_openid && m.username) {
              userContent = userContent.replace(new RegExp(`<@${m.member_openid}>`, "g"), `@${m.username}`);
            }
          }
        }

        // 群消息 user prompt 带上发送者昵称（合并消息已内嵌发送者前缀，不再重复添加）
        const isMergedMsg = mergedCount && mergedCount > 1;
        const senderPrefix = (event.type === "group" && !isMergedMsg)
          ? `[${event.senderName ? `${event.senderName} (${event.senderId})` : event.senderId}] `
          : "";
        const isAtYouTag = event.type === "group"
          ? (wasMentioned ? " (@你)" : "")
          : "";

        // 合并消息：前面的消息用 envelope 历史格式，最后一条用当前消息格式（与 mention 单条回复对齐）
        // BodyForAgent 只包含动态上下文 + 用户消息，不拼入 systemPrompts。
        // systemPrompts（[QQBot] to=...、TTS 能力声明等）通过 GroupSystemPrompt 注入到
        // 框架的 extraSystemPrompt 中，不会存入 transcript 的 user turn content，
        // 避免 Web UI 不显示用户 query 的问题。
        let userMessage: string;
        const mergedMessages = (event as QueuedMessage)._mergedMessages;
        if (isMergedMsg && mergedMessages?.length) {
          // --- 辅助：格式化单条子消息内容（表情解析 + mention 清理 + 附件标签） ---
          const formatSubMsgContent = (m: QueuedMessage): string =>
            formatMessageContent({
              content: m.content ?? "",
              chatType: m.type,
              mentions: m.mentions as unknown[],
              attachments: m.attachments,
              parseFaceTags,
              stripMentionText: (text, mentions) =>
                qqbotPlugin.mentions?.stripMentionText?.(text, mentions as any) ?? text,
            });

          // 前面的消息使用 envelope 历史格式
          const preceding = mergedMessages.slice(0, -1);
          const lastMsg = mergedMessages[mergedMessages.length - 1];

          const envelopeParts = preceding.map((m) => {
            const msgContent = formatSubMsgContent(m);
            const senderName = m.senderName
              ? (m.senderName.includes(m.senderId) ? m.senderName : `${m.senderName} (${m.senderId})`)
              : m.senderId;
            return pluginRuntime.channel.reply.formatInboundEnvelope({
              channel: "qqbot",
              from: senderName,
              timestamp: new Date(m.timestamp).getTime(),
              body: msgContent,
              chatType: "group",
              envelope: envelopeOptions,
            });
          });

          // 最后一条消息使用简洁格式：[发送者]: 内容 (@你)
          const lastContent = formatSubMsgContent(lastMsg);
          const lastSenderName = lastMsg.senderName
            ? (lastMsg.senderName.includes(lastMsg.senderId) ? lastMsg.senderName : `${lastMsg.senderName} (${lastMsg.senderId})`)
            : lastMsg.senderId;
          const lastPart = `[${lastSenderName}] ${lastContent}${isAtYouTag}`;

          // 前置消息用段落标签包裹（类似引用消息的 [引用消息开始]...[引用消息结束]）
          userMessage = buildMergedMessageContext({
            precedingParts: envelopeParts,
            currentMessage: lastPart,
          });
        } else {
          // 命令直接透传，不注入上下文
          userMessage = senderPrefix ? `${senderPrefix}${quotePart}${userContent}${isAtYouTag}` : `${quotePart}${userContent}`;
        }
        let agentBody = userContent.startsWith("/")
          ? userContent
          : `${dynamicCtx}${userMessage}`;

        // 被@时：将累积的非@历史消息注入上下文
        // 消息格式使用 formatInboundEnvelope 与正常消息保持一致
        if (event.type === "group" && event.groupOpenid) {
          const historyLimit = resolveHistoryLimit(cfg as any, event.groupOpenid, account.accountId);
          const envelopeOpts = pluginRuntime.channel.reply.resolveEnvelopeFormatOptions(cfg);
          agentBody = buildPendingHistoryContext({
            historyMap: groupHistories,
            historyKey: event.groupOpenid,
            limit: historyLimit,
            currentMessage: agentBody,
            formatEntry: (entry) => {
              // 将附件描述追加到消息 body 末尾，确保富媒体上下文不丢失
              const attachmentDesc = formatAttachmentTags(entry.attachments);
              const bodyWithAttachments = attachmentDesc
                ? `${entry.body} ${attachmentDesc}`
                : entry.body;
              return pluginRuntime.channel.reply.formatInboundEnvelope({
                channel: "qqbot",
                from: entry.sender,
                timestamp: entry.timestamp,
                body: bodyWithAttachments,
                chatType: "group",
                envelope: envelopeOpts,
              });
            },
          });
        }

        log?.info(`[qqbot:${account.accountId}] agentBody length: ${agentBody.length}`);

        const fromAddress = event.type === "guild" ? `qqbot:channel:${event.channelId}`
                         : event.type === "group" ? `qqbot:group:${event.groupOpenid}`
                         : `qqbot:c2c:${event.senderId}`;
        const toAddress = fromAddress;

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

        // QQBot 静态系统提示（投递地址、TTS 能力等）合并到 GroupSystemPrompt，
        // 通过框架的 extraSystemPrompt 机制注入 AI system prompt，
        // 不会存入 transcript 的 user turn content。
        const qqbotSystemInstruction = systemPrompts.length > 0 ? systemPrompts.join("\n") : "";
        const mergedGroupSystemPrompt = [qqbotSystemInstruction, groupSystemPrompt].filter(Boolean).join("\n") || undefined;

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
          GroupSystemPrompt: mergedGroupSystemPrompt,
          // 群消息元数据（框架级字段）
          WasMentioned: isGroupChat ? wasMentioned : undefined,
          SenderLabel: isGroupChat ? senderLabel : undefined,
          GroupSubject: isGroupChat ? groupSubject : undefined,
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
          // 引用消息上下文
          ...(replyToId ? {
            ReplyToId: replyToId,
            ReplyToBody: replyToBody,
            ReplyToSender: replyToSender,
            ReplyToIsQuote: replyToIsQuote,
          } : {}),
        });

        // 构建回复上下文
        const replyTarget: MessageTarget = {
          type: event.type,
          senderId: event.senderId,
          messageId: event.messageId,
          channelId: event.channelId,
          groupOpenid: event.groupOpenid,
        };
        const replyCtx: ReplyContext = { target: replyTarget, account, cfg, log };

        // 简化的 token 重试包装（使用 reply-dispatcher 的通用实现）
        const sendWithRetry = <T>(sendFn: (token: string) => Promise<T>) =>
          sendWithTokenRetry(account.appId, account.clientSecret, sendFn, log, account.accountId);

        // 发送错误提示的辅助函数
        const sendErrorMessage = (errorText: string) => sendErrorToTarget(replyCtx, errorText);

        // 使用 AsyncLocalStorage 建立请求级上下文，作用域内所有异步代码
        // （包括 AI agent 调用、tool execute）都能安全获取当前会话信息，无并发竞态。
        await runWithRequestContext({ target: qualifiedTarget }, async () => {
        try {
          const messagesConfig = pluginRuntime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);

          // 追踪是否有响应
          let hasResponse = false;
          let hasBlockResponse = false; // 是否收到了面向用户的 block 回复
          let toolDeliverCount = 0; // tool deliver 计数
          const toolTexts: string[] = []; // 收集所有 tool deliver 文本
          const toolMediaUrls: string[] = []; // 收集所有 tool deliver 媒体 URL
          let toolFallbackSent = false; // 兜底消息是否已发送（只发一次）
          const blockDeliveredMediaUrls = new Set<string>(); // block deliver 已处理的 mediaUrl，用于 tool 后到时去重
          const responseTimeout = 120000; // 120秒超时（2分钟，与 TTS/文件生成超时对齐）
          const toolOnlyTimeout = 60000; // tool-only 兜底超时：60秒内没有 block 就兜底
          const maxToolRenewals = 3; // tool 续期上限：最多续期 3 次（总等待 = 60s × 3 = 180s）
          let toolRenewalCount = 0; // 已续期次数
          let timeoutId: ReturnType<typeof setTimeout> | null = null;
          let toolOnlyTimeoutId: ReturnType<typeof setTimeout> | null = null;

          // ============ Deliver Debouncer：合并短时间内连续到达的 block deliver ============
          const debounceConfig = account.config?.deliverDebounce;
          let debouncer: DeliverDebouncer | null = null as DeliverDebouncer | null;

          // tool-only 兜底：转发工具产生的实际内容（媒体/文本），而非生硬的提示语
          const sendToolFallback = async (): Promise<void> => {
            // 优先发送工具产出的媒体文件（TTS 语音、生成图片等）
            if (toolMediaUrls.length > 0) {
              log?.info(`[qqbot:${account.accountId}] Tool fallback: forwarding ${toolMediaUrls.length} media URL(s) from tool deliver(s)`);
              const mediaTimeout = 45000; // 单个媒体发送超时 45s
              for (const mediaUrl of toolMediaUrls) {
                try {
                  const result = await Promise.race([
                    sendMediaAuto({
                      to: qualifiedTarget,
                      text: "",
                      mediaUrl,
                      accountId: account.accountId,
                      replyToId: event.messageId,
                      account,
                    }),
                    new Promise<{ channel: string; error: string }>((resolve) =>
                      setTimeout(() => resolve({ channel: "qqbot", error: `Tool fallback media send timeout (${mediaTimeout / 1000}s)` }), mediaTimeout)
                    ),
                  ]);
                  if (result.error) {
                    log?.error(`[qqbot:${account.accountId}] Tool fallback sendMedia error: ${result.error}`);
                  }
                } catch (err) {
                  log?.error(`[qqbot:${account.accountId}] Tool fallback sendMedia failed: ${err}`);
                }
              }
              return;
            }
            // 其次转发工具产出的文本
            if (toolTexts.length > 0) {
              const text = toolTexts.slice(-3).join("\n---\n").slice(0, 2000);
              log?.info(`[qqbot:${account.accountId}] Tool fallback: forwarding tool text (${text.length} chars)`);
              await sendErrorMessage(text);
              return;
            }
            // 既无媒体也无文本，静默处理（仅日志记录）
            log?.info(`[qqbot:${account.accountId}] Tool fallback: no media or text collected from ${toolDeliverCount} tool deliver(s), silently dropping`);
          };

          const timeoutPromise = new Promise<void>((_, reject) => {
            timeoutId = setTimeout(() => {
              if (!hasResponse) {
                reject(new Error("Response timeout"));
              }
            }, responseTimeout);
          });


          // ============ 流式消息控制器 ============
          const targetType = event.type === "c2c" ? "c2c" as const
                          : event.type === "group" ? "group" as const
                          : "channel" as const;
          const useStreaming = shouldUseStreaming(account, targetType);
          log?.info(`[qqbot:${account.accountId}] Streaming ${useStreaming ? "enabled" : "disabled"} for ${targetType} message from ${event.senderId}`);
          let streamingController: StreamingController | null = null;

          /** 创建一个新的 StreamingController 实例（用于初始创建和回复边界时重建） */
          const createStreamingController = (): StreamingController => {
            const ctrl = new StreamingController({
              account,
              userId: event.senderId,
              replyToMsgId: event.messageId,
              eventId: event.messageId,
              logPrefix: `[qqbot:${account.accountId}:streaming]`,
              log,
              mediaContext: {
                account,
                event: {
                  type: event.type as "c2c" | "group" | "channel",
                  senderId: event.senderId,
                  messageId: event.messageId,
                  groupOpenid: event.groupOpenid,
                  channelId: event.channelId,
                },
                log,
              },
              // 回复边界回调：终结旧 controller 后创建新的，用新回复文本继续流式
              onReplyBoundary: async (newReplyText: string) => {
                log?.info(`[qqbot:${account.accountId}] Reply boundary: creating new StreamingController for new reply`);
                const newCtrl = createStreamingController();
                streamingController = newCtrl;
                // 将新回复的初始文本交给新 controller 处理
                await newCtrl.onPartialReply({ text: newReplyText });
              },
            });
            return ctrl;
          };

          if (useStreaming) {
            log?.info(`[qqbot:${account.accountId}] Streaming mode enabled for ${targetType} target`);
            streamingController = createStreamingController();
          }


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
                  // 收集工具产出的媒体 URL（TTS 语音、生成图片等），供 fallback 转发
                  if (payload.mediaUrls?.length) {
                    toolMediaUrls.push(...payload.mediaUrls);
                  }
                  if (payload.mediaUrl && !toolMediaUrls.includes(payload.mediaUrl)) {
                    toolMediaUrls.push(payload.mediaUrl);
                  }
                  log?.info(`[qqbot:${account.accountId}] Collected tool deliver #${toolDeliverCount}: text=${toolText.length} chars, media=${toolMediaUrls.length} URLs`);

                  // block 已先发送完毕，tool 后到的媒体立即转发（典型场景：AI 先流式输出文本再执行 TTS）
                  if (hasBlockResponse && toolMediaUrls.length > 0) {
                    // 去重：跳过已被 block deliver 的 sendPlainReply 处理过的 URL
                    const urlsToSend = toolMediaUrls.filter(url => !blockDeliveredMediaUrls.has(url));
                    const skippedCount = toolMediaUrls.length - urlsToSend.length;
                    toolMediaUrls.length = 0;
                    if (urlsToSend.length === 0) {
                      log?.info(`[qqbot:${account.accountId}] All ${skippedCount} tool media URL(s) already handled by block deliver, skipping`);
                      return;
                    }
                    log?.info(`[qqbot:${account.accountId}] Block already sent, immediately forwarding ${urlsToSend.length} tool media URL(s) (deduped from block deliver)`);
                    for (const mediaUrl of urlsToSend) {
                      try {
                        const result = await sendMediaAuto({
                          to: qualifiedTarget,
                          text: "",
                          mediaUrl,
                          accountId: account.accountId,
                          replyToId: event.messageId,
                          account,
                        });
                        if (result.error) {
                          log?.error(`[qqbot:${account.accountId}] Tool media immediate forward error: ${result.error}`);
                        } else {
                          log?.info(`[qqbot:${account.accountId}] Forwarded tool media (post-block): ${mediaUrl.slice(0, 80)}...`);
                        }
                      } catch (err) {
                        log?.error(`[qqbot:${account.accountId}] Tool media immediate forward failed: ${err}`);
                      }
                    }
                    return;
                  }

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
                      try {
                        await sendToolFallback();
                      } catch (sendErr) {
                        log?.error(`[qqbot:${account.accountId}] Failed to send tool-only fallback: ${sendErr}`);
                      }
                    }
                  }, toolOnlyTimeout);
                  return;
                }

                // 收到 block 回复，清除所有超时定时器
                hasBlockResponse = true;
                // 收到真正回复，立即停止输入状态续期（让 "输入中" 尽快消失）
                typing.keepAlive?.stop();
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

                // ============ 流式模式处理 ============
                // 流式模式下，所有 block deliver 内容（含媒体标签）统一交由 StreamingController 处理。
                // StreamingController 内部有重试机制；如果一个分片都没发出去则降级到普通消息。
                if (streamingController && !streamingController.isTerminalPhase) {
                  const deliverTextLen = (payload.text ?? "").length;
                  const deliverPreview = (payload.text ?? "").slice(0, 40).replace(/\n/g, "\\n");
                  log?.debug?.(`[qqbot:${account.accountId}] Streaming deliver entry, textLen=${deliverTextLen}, phase=${streamingController.currentPhase}, sentChunks=${streamingController.sentChunkCount_debug}, preview="${deliverPreview}"`);
                  try {
                    await streamingController.onDeliver(payload);
                    log?.debug?.(`[qqbot:${account.accountId}] Streaming deliver done, phase=${streamingController.currentPhase}`);
                  } catch (err) {
                    // StreamingController 内部已有重试，这里只打日志
                    log?.error(`[qqbot:${account.accountId}] Streaming deliver error: ${err}`);
                  }

                let replyText = payload.text ?? "";
                
                // 群消息：模型回复 NO_REPLY 表示无需回复，跳过发送
                // 注意：核心框架的 reply-delivery 已会拦截 NO_REPLY，此处为双重保险
                const trimmedReply = replyText.trim();
                if (event.type === "group" && (trimmedReply === "NO_REPLY" || trimmedReply === "[SKIP]")) {
                  log?.info(`[qqbot:${account.accountId}] Model decided to skip group message (token=${trimmedReply}) from ${event.senderId}: ${event.content?.slice(0, 50)}`);
                  return;
                }

                  // 检查是否因流式 API 不可用而需要降级（ensureStreamingStarted 全部失败）
                  // 如果需要降级，不 return，让本次 deliver 的 payload.text（全量文本）继续走普通发送逻辑
                  if (streamingController.shouldFallbackToStatic) {
                    log?.info(`[qqbot:${account.accountId}] Streaming API unavailable, falling back to static for this deliver`);
                    // 不 return，继续走普通发送逻辑（payload.text 是完整文本）
                  } else {
                    // 流式正常处理，不走普通发送逻辑
                    pluginRuntime.channel.activity.record({
                      channel: "qqbot",
                      accountId: account.accountId,
                      direction: "outbound",
                    });
                    return;
                  }
                }

                // ============ 实际发送逻辑（可被 debouncer 包裹） ============
                const executeDeliver = async (deliverPayload: { text?: string; mediaUrls?: string[]; mediaUrl?: string }, _deliverInfo: { kind: string }) => {
                  // ============ 引用回复 ============
                  const quoteRef = event.msgIdx;
                  let quoteRefUsed = false;
                  const consumeQuoteRef = (): string | undefined => {
                    if (quoteRef && !quoteRefUsed) {
                      quoteRefUsed = true;
                      return quoteRef;
                    }
                    return undefined;
                  };

                  let replyText = deliverPayload.text ?? "";

                  // ============ 媒体标签解析 + 发送 ============
                  const deliverEvent: DeliverEventContext = {
                    type: event.type,
                    senderId: event.senderId,
                    messageId: event.messageId,
                    channelId: event.channelId,
                    groupOpenid: event.groupOpenid,
                    msgIdx: event.msgIdx,
                  };
                  const deliverActx: DeliverAccountContext = { account, qualifiedTarget, log };

                  const mediaResult = await parseAndSendMediaTags(
                    replyText, deliverEvent, deliverActx, sendWithRetry, consumeQuoteRef,
                  );
                  if (mediaResult.handled) {
                    pluginRuntime.channel.activity.record({
                      channel: "qqbot",
                      accountId: account.accountId,
                      direction: "outbound",
                    });
                    return;
                  }
                  replyText = mediaResult.normalizedText;

                  // ============ 结构化载荷检测与分发 ============
                  const recordOutboundActivity = () => pluginRuntime.channel.activity.record({
                    channel: "qqbot",
                    accountId: account.accountId,
                    direction: "outbound",
                  });
                  const handled = await handleStructuredPayload(replyCtx, replyText, recordOutboundActivity);
                  if (handled) return;

                  // ============ 非结构化消息发送 ============
                  // 记录 block deliver 处理的 mediaUrl，供 tool 后到时去重
                  if (deliverPayload.mediaUrl) blockDeliveredMediaUrls.add(deliverPayload.mediaUrl);
                  if (deliverPayload.mediaUrls) for (const u of deliverPayload.mediaUrls) blockDeliveredMediaUrls.add(u);

                  await sendPlainReply(
                    deliverPayload, replyText, deliverEvent, deliverActx,
                    sendWithRetry, consumeQuoteRef, toolMediaUrls,
                  );

                  pluginRuntime.channel.activity.record({
                    channel: "qqbot",
                    accountId: account.accountId,
                    direction: "outbound",
                  });
                };

                // ============ Debounce 合并回复 ============
                if (!debouncer) {
                  debouncer = createDeliverDebouncer(
                    debounceConfig,
                    executeDeliver,
                    log,
                    `[qqbot:${account.accountId}:debounce]`,
                  );
                }

                if (debouncer) {
                  await debouncer.deliver(payload, info);
                } else {
                  await executeDeliver(payload, info);
                }
              },
              onError: async (err: unknown) => {
                log?.error(`[qqbot:${account.accountId}] Dispatch error: ${err}`);
                hasResponse = true;
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }

                // 流式模式：委托给 streaming controller 处理错误
                if (streamingController && !streamingController.isTerminalPhase) {
                  try {
                    await streamingController.onError(err);
                  } catch (streamErr) {
                    log?.error(`[qqbot:${account.accountId}] Streaming onError failed: ${streamErr}`);
                  }

                  // 如果 onError 中因无分片发出而降级，不 return，走普通错误处理
                  if (streamingController.shouldFallbackToStatic) {
                    log?.info(`[qqbot:${account.accountId}] Streaming onError: no chunk sent, falling back to static error handling`);
                    // 不 return，继续走普通错误处理
                  } else {
                    return;
                  }
                }
                
                const errMsg = String(err);

                // 兼容 openclaw 3.23+ 的 plugin-sdk/root-alias.cjs 模块解析失败
                if (errMsg.includes("Unable to resolve plugin runtime module") || errMsg.includes("root-alias.cjs")) {
                  log?.error(`[qqbot:${account.accountId}] ⚠️ openclaw 框架 runtime 模块解析失败，可能是 openclaw 版本与 plugin-sdk 不兼容。请尝试: npm install -g openclaw@latest && openclaw gateway restart`);
                  await sendErrorMessage("⚠️ AI 服务暂时不可用：openclaw 框架运行时模块加载失败。\n\n请管理员执行：\nnpm install -g openclaw@latest\nopenclaw gateway restart\n\n斜杠命令（如 /bot-ping）不受影响。");
                  return;
                }

                if (errMsg.includes("401") || errMsg.includes("key") || errMsg.includes("auth")) {
                  log?.error(`[qqbot:${account.accountId}] AI auth error: ${errMsg}`);
                } else {
                  log?.error(`[qqbot:${account.accountId}] AI process error: ${errMsg}`);
                }
              },
            },
            replyOptions: {
              // 流式模式时禁用 block streaming
              disableBlockStreaming: !useStreaming,
              // 流式模式下注册 onPartialReply 回调，接收流式文本增量
              ...(streamingController ? {
                onPartialReply: async (payload: { text?: string }) => {
                  const textLen = payload.text?.length ?? 0;
                  const preview = (payload.text ?? "").slice(0, 40).replace(/\n/g, "\\n");
                  log?.debug?.(`[qqbot:${account.accountId}] onPartialReply called, textLen=${textLen}, phase=${streamingController!.currentPhase}, isTerminal=${streamingController!.isTerminalPhase}, preview="${preview}"`);
                  try {
                    await streamingController!.onPartialReply(payload);
                    log?.debug?.(`[qqbot:${account.accountId}] onPartialReply done, phase=${streamingController!.currentPhase}`);
                  } catch (err) {
                    // StreamingController 内部已有重试，这里只打日志
                    log?.error(`[qqbot:${account.accountId}] Streaming onPartialReply error: ${err}`);
                  }
                },
              } : {}),
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
              await sendToolFallback();
            }
            // 销毁 debouncer，flush 剩余缓冲的文本
            if (debouncer) {
              await debouncer.dispose();
              debouncer = null;
            }

            // ============ 流式消息收尾 ============
            // dispatch 完成后，标记流式控制器已完成并触发 onIdle（发送终结分片）
            if (streamingController && !streamingController.isTerminalPhase) {
              try {
                streamingController.markFullyComplete();
                await streamingController.onIdle();
                log?.debug?.(`[qqbot:${account.accountId}] Streaming controller finalized`);
              } catch (err) {
                log?.error(`[qqbot:${account.accountId}] Streaming finalization error: ${err}`);
                // 尝试中止
                try { await streamingController.abortStreaming(); } catch { /* ignore */ }
              }
            }

            // ============ 流式降级到非流式 ============
            // 无需额外处理：如果流式 API 不可用（shouldFallbackToStatic），
            // deliver 回调中已自动跳过流式拦截，走普通消息发送逻辑。
            // （每次 deliver 收到的都是全量文本，不需要在 controller 内部保存累积文本）
            if (streamingController?.shouldFallbackToStatic) {
              log?.debug?.(`[qqbot:${account.accountId}] Streaming was degraded to static mode (no chunk sent successfully)`);
            }

            // 回复完成后清空群历史缓存（每次回复后重新累积）
            if (event.type === "group" && event.groupOpenid) {
              const historyLimit = resolveHistoryLimit(cfg as any, event.groupOpenid, account.accountId);
              clearPendingHistory({
                historyMap: groupHistories,
                historyKey: event.groupOpenid,
                limit: historyLimit,
              });
            }
          }
        } catch (err) {
          const errStr = String(err);
          log?.error(`[qqbot:${account.accountId}] Message processing failed: ${err}`);
          // 兼容 openclaw 3.23+ runtime 模块解析失败：给用户发可操作的提示
          if (errStr.includes("Unable to resolve plugin runtime module") || errStr.includes("root-alias.cjs")) {
            try {
              await sendErrorMessage("⚠️ AI 服务暂时不可用：openclaw 框架运行时模块加载失败。\n\n请管理员执行：\nnpm install -g openclaw@latest\nopenclaw gateway restart\n\n斜杠命令（如 /bot-ping）不受影响。");
            } catch { /* best-effort */ }
          }
        } finally {
          // 无论成功/失败/超时，都停止输入状态续期
          typing.keepAlive?.stop();
        }
        }); // end runWithRequestContext
      };

      ws.on("open", () => {
        log?.info(`[qqbot:${account.accountId}] WebSocket connected`);
        isConnecting = false; // 连接完成，释放锁
        reconnectAttempts = 0; // 连接成功，重置重试计数
        lastConnectTime = Date.now(); // 记录连接时间
        // 启动消息处理器（异步处理，防止阻塞心跳）
        msgQueue.startProcessor(handleMessage);
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
                intentLevelIndex: 0,
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
                // 新连接，发送 Identify，始终使用完整权限
                log?.info(`[qqbot:${account.accountId}] Sending identify with intents: ${FULL_INTENTS} (${FULL_INTENTS_DESC})`);
                ws.send(JSON.stringify({
                  op: 2,
                  d: {
                    token: `QQBot ${accessToken}`,
                    intents: FULL_INTENTS,
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
              log?.info(`[qqbot:${account.accountId}] 📩 Dispatch event: t=${t}, d=${JSON.stringify(d)}`);
              if (t === "READY") {
                const readyData = d as { session_id: string };
                sessionId = readyData.session_id;
                log?.info(`[qqbot:${account.accountId}] Ready with ${FULL_INTENTS_DESC}, session: ${sessionId}`);
                // P1-2: 保存新的 Session 状态
                saveSession({
                  sessionId,
                  lastSeq,
                  lastConnectedAt: Date.now(),
                  intentLevelIndex: 0,
                  accountId: account.accountId,
                  savedAt: Date.now(),
                  appId: account.appId,
                });
                onReady?.(d);

                // 仅 startGateway 后的首次 READY 才发送上线通知
                // ws 断线重连（resume 失败后重新 Identify）产生的 READY 不发送
                if (!_pendingFirstReady.has(account.accountId)) {
                  log?.info(`[qqbot:${account.accountId}] Skipping startup greeting (reconnect READY, not first startup)`);
                } else {
                  _pendingFirstReady.delete(account.accountId);
                  sendStartupGreetings(adminCtx, "READY");
                } // end isFirstReady
              } else if (t === "RESUMED") {
                log?.info(`[qqbot:${account.accountId}] Session resumed`);
                onReady?.(d); // 通知框架连接已恢复，避免 health-monitor 误判 disconnected
                // RESUMED 也属于首次启动（gateway restart 通常走 resume）
                if (_pendingFirstReady.has(account.accountId)) {
                  _pendingFirstReady.delete(account.accountId);
                  sendStartupGreetings(adminCtx, "RESUMED");
                }
                // P1-2: 更新 Session 连接时间
                if (sessionId) {
                  saveSession({
                    sessionId,
                    lastSeq,
                    lastConnectedAt: Date.now(),
                    intentLevelIndex: 0,
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
                // 斜杠指令拦截 → 不匹配则入队
                trySlashCommandOrEnqueue({
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
                trySlashCommandOrEnqueue({
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
                trySlashCommandOrEnqueue({
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
                // 被 @ 的消息，直接入队回复
                recordKnownUser({
                  openid: event.author.member_openid,
                  type: "group",
                  nickname: event.author.username,
                  groupOpenid: event.group_openid,
                  accountId: account.accountId,
                });
                const groupRefs = parseRefIndices(event.message_scene?.ext);
                trySlashCommandOrEnqueue({
                  type: "group",
                  senderId: event.author.member_openid,
                  senderName: event.author.username,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  groupOpenid: event.group_openid,
                  attachments: event.attachments,
                  refMsgIdx: groupRefs.refMsgIdx,
                  msgIdx: groupRefs.msgIdx,
                  eventType: "GROUP_AT_MESSAGE_CREATE",
                  mentions: event.mentions,
                  messageScene: event.message_scene,
                });
              } else if (t === "GROUP_MESSAGE_CREATE") {
                const event = d as GroupMessageEvent;
                recordKnownUser({
                  openid: event.author.member_openid,
                  type: "group",
                  nickname: event.author.username,
                  groupOpenid: event.group_openid,
                  accountId: account.accountId,
                });
                const groupRefs = parseRefIndices(event.message_scene?.ext);
                trySlashCommandOrEnqueue({
                  type: "group",
                  senderId: event.author.member_openid,
                  senderName: event.author.username,
                  senderIsBot: event.author.bot,
                  content: event.content,
                  messageId: event.id,
                  timestamp: event.timestamp,
                  groupOpenid: event.group_openid,
                  attachments: event.attachments,
                  refMsgIdx: groupRefs.refMsgIdx,
                  msgIdx: groupRefs.msgIdx,
                  eventType: "GROUP_MESSAGE_CREATE",
                  mentions: event.mentions,
                  messageScene: event.message_scene,
                });
              } else if (t === "GROUP_ADD_ROBOT") {
                const event = d as { timestamp: string; group_openid: string; op_member_openid: string };
                log?.info(`[qqbot:${account.accountId}] Bot added to group: ${event.group_openid} by ${event.op_member_openid}`);
                recordKnownUser({
                  openid: event.op_member_openid,
                  type: "group",
                  groupOpenid: event.group_openid,
                  accountId: account.accountId,
                });
                // 发送入群欢迎
                (async () => {
                  try {
                    const token = await getAccessToken(account.appId, account.clientSecret);
                    const greeting = `嗨～我来啦！有事随时喊我就好 😄`;
                    await sendProactiveGroupMessage(token, event.group_openid, greeting);
                    log?.info(`[qqbot:${account.accountId}] Sent welcome message to group: ${event.group_openid}`);
                  } catch (err) {
                    log?.debug?.(`[qqbot:${account.accountId}] Failed to send welcome message to group ${event.group_openid}: ${err}`);
                  }
                })();
              } else if (t === "GROUP_DEL_ROBOT") {
                const event = d as { timestamp: string; group_openid: string; op_member_openid: string };
                log?.info(`[qqbot:${account.accountId}] Bot removed from group: ${event.group_openid} by ${event.op_member_openid}`);
              } else if (t === "GROUP_MSG_REJECT") {
                const event = d as { timestamp: number; group_openid: string; op_member_openid: string };
                log?.info(`[qqbot:${account.accountId}] Group ${event.group_openid} rejected bot proactive messages (by ${event.op_member_openid})`);
              } else if (t === "GROUP_MSG_RECEIVE") {
                const event = d as { timestamp: number; group_openid: string; op_member_openid: string };
                log?.info(`[qqbot:${account.accountId}] Group ${event.group_openid} accepted bot proactive messages (by ${event.op_member_openid})`);
              } else if (t === "INTERACTION_CREATE") {
                const event = d as InteractionEvent;
                const resolved = event.data?.resolved;
                const sceneDesc = event.scene ?? (event.chat_type === 0 ? "guild" : event.chat_type === 1 ? "group" : "c2c");
                log?.info(`[qqbot:${account.accountId}] Interaction: scene=${sceneDesc}, type=${event.data?.type}, button_id=${resolved?.button_id}, button_data=${resolved?.button_data}, user=${event.group_member_openid || event.user_openid || resolved?.user_id || "unknown"}`);

                handleInteractionCreate({ event, account, cfg, log }).catch((err) => {
                  log?.error(`[qqbot:${account.accountId}] Failed to handle interaction ${event.id}: ${err}`);
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
              log?.error(`[qqbot:${account.accountId}] Invalid session (${FULL_INTENTS_DESC}), can resume: ${canResume}, raw: ${rawData}`);
              
              if (!canResume) {
                sessionId = null;
                lastSeq = null;
                // P1-2: 清除持久化的 Session
                clearSession(account.accountId);
                shouldRefreshToken = true;
                log?.info(`[qqbot:${account.accountId}] Will refresh token and retry with full intents (${FULL_INTENTS_DESC})`);
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
        
        // 根据错误码处理（见 QQ 官方文档）
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
