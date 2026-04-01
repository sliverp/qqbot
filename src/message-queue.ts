import type { QueueSnapshot } from "./slash-commands.js";
import type { MsgElement } from "./types.js";

// ── 消息队列默认配置 ──
const DEFAULT_GLOBAL_QUEUE_SIZE = 1000;
const DEFAULT_PER_PEER_QUEUE_SIZE = 20;
const DEFAULT_GROUP_QUEUE_SIZE = 50;
const DEFAULT_MAX_CONCURRENT_USERS = 10;

/**
 * 消息队列项类型（用于异步处理消息，防止阻塞心跳）
 */
export interface QueuedMessage {
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
  /** 事件类型（如 GROUP_AT_MESSAGE_CREATE），用于群消息合并时判断是否有 @ */
  eventType?: string;
  /** 发送者是否为机器人 */
  senderIsBot?: boolean;
  /** @ 提及列表（群消息合并时需要去重合并） */
  mentions?: Array<{ scope?: "all" | "single"; id?: string; user_openid?: string; member_openid?: string; username?: string; bot?: boolean; is_you?: boolean }>;
  /** 消息场景（来源、扩展字段） */
  messageScene?: { source?: string; ext?: string[] };
  /** 消息元素列表，引用消息时 [0] 为被引用的原始消息 */
  msgElements?: MsgElement[];
  /** 消息类型，参见 MSG_TYPE_* */
  msgType?: number;
  /** 群消息合并标记：记录合并了多少条原始消息 */
  _mergedCount?: number;
  /** 合并前的原始消息列表（用于 gateway 侧逐条格式化信封） */
  _mergedMessages?: QueuedMessage[];
}

export interface MessageQueueContext {
  accountId: string;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** 外部提供的 abort 状态检查 */
  isAborted: () => boolean;
  /** 群聊队列上限（默认 50） */
  groupQueueSize?: number;
  /** 私聊/DM 队列上限（默认 20） */
  peerQueueSize?: number;
  /** 全局队列总量上限（默认 1000） */
  globalQueueSize?: number;
  /** 最大并发处理用户数（默认 10） */
  maxConcurrentUsers?: number;
}

export interface MessageQueue {
  enqueue: (msg: QueuedMessage) => void;
  startProcessor: (handleMessageFn: (msg: QueuedMessage) => Promise<void>) => void;
  getSnapshot: (senderPeerId: string) => QueueSnapshot;
  getMessagePeerId: (msg: QueuedMessage) => string;
  /** 清空指定用户的排队消息，返回被丢弃的消息数 */
  clearUserQueue: (peerId: string) => number;
  /** 立即执行一条消息（绕过队列），用于紧急命令 */
  executeImmediate: (msg: QueuedMessage) => void;
}

// ── 群消息合并工具函数 ──

/** 判断 peerId 是否属于群聊 */
const isGroupPeer = (peerId: string): boolean =>
  peerId.startsWith("group:") || peerId.startsWith("guild:");

/**
 * 将多条群消息合并为一条，用于群聊场景下排队消息的批量处理。
 * - content 拼接为多行，每行带发送者前缀
 * - 附件合并
 * - messageId / msgIdx / timestamp 取最后一条（用于回复引用）
 * - mentions 合并去重
 * - 如果有任意一条 @了你（is_you），合并结果也标记 @你
 * - senderIsBot 只要有一条不是 bot 就算非 bot
 */
function mergeGroupMessages(batch: QueuedMessage[]): QueuedMessage {
  if (batch.length === 1) return batch[0];

  const last = batch[batch.length - 1];
  const first = batch[0];

  // 拼接内容：每条消息带发送者前缀
  const mergedContent = batch
    .map((m) => {
      const name = m.senderName ?? m.senderId;
      return `[${name}]: ${m.content}`;
    })
    .join("\n");

  // 合并附件
  const mergedAttachments: QueuedMessage["attachments"] = [];
  for (const m of batch) {
    if (m.attachments?.length) {
      mergedAttachments.push(...m.attachments);
    }
  }

  // 合并 mentions（去重 by member_openid/id）
  const seenMentionIds = new Set<string>();
  const mergedMentions: NonNullable<QueuedMessage["mentions"]> = [];
  let hasAtYouEvent = false;
  for (const m of batch) {
    if (m.eventType === "GROUP_AT_MESSAGE_CREATE") {
      hasAtYouEvent = true;
    }
    if (m.mentions) {
      for (const mt of m.mentions) {
        const key = mt.member_openid ?? mt.id ?? mt.user_openid ?? "";
        if (key && seenMentionIds.has(key)) continue;
        if (key) seenMentionIds.add(key);
        mergedMentions.push(mt);
      }
    }
  }

  // senderIsBot: 只要有一条来自非 bot 用户，就算非 bot
  const allFromBot = batch.every((m) => m.senderIsBot);

  return {
    type: last.type,
    senderId: last.senderId,
    senderName: last.senderName,
    senderIsBot: allFromBot,
    content: mergedContent,
    messageId: last.messageId,
    timestamp: last.timestamp,
    channelId: last.channelId,
    guildId: last.guildId,
    groupOpenid: last.groupOpenid,
    attachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
    refMsgIdx: first.refMsgIdx,
    msgIdx: last.msgIdx,
    eventType: hasAtYouEvent ? "GROUP_AT_MESSAGE_CREATE" : last.eventType,
    mentions: mergedMentions.length > 0 ? mergedMentions : undefined,
    messageScene: last.messageScene,
    _mergedCount: batch.length,
    _mergedMessages: batch.length > 1 ? batch : undefined,
  };
}

/**
 * 创建按用户并发的消息队列（同用户串行，跨用户并行）
 *
 * 内置群消息增强：
 * - 群聊 / 私聊使用不同队列上限
 * - 群聊溢出时优先丢弃 bot 消息
 * - drain 时自动合并群聊排队消息（斜杠命令单独处理）
 */
export function createMessageQueue(ctx: MessageQueueContext): MessageQueue {
  const { accountId, log } = ctx;
  const globalQueueSize = ctx.globalQueueSize ?? DEFAULT_GLOBAL_QUEUE_SIZE;
  const peerQueueSize = ctx.peerQueueSize ?? DEFAULT_PER_PEER_QUEUE_SIZE;
  const groupQueueSize = ctx.groupQueueSize ?? DEFAULT_GROUP_QUEUE_SIZE;
  const maxConcurrentUsers = ctx.maxConcurrentUsers ?? DEFAULT_MAX_CONCURRENT_USERS;

  const userQueues = new Map<string, QueuedMessage[]>();
  const activeUsers = new Set<string>();
  let handleMessageFnRef: ((msg: QueuedMessage) => Promise<void>) | null = null;
  let totalEnqueued = 0;

  const getMessagePeerId = (msg: QueuedMessage): string => {
    if (msg.type === "guild") return `guild:${msg.channelId ?? "unknown"}`;
    if (msg.type === "group") return `group:${msg.groupOpenid ?? "unknown"}`;
    return `dm:${msg.senderId}`;
  };

  /** 从满队列中淘汰一条消息（群聊优先丢弃 bot 消息，否则丢弃最旧） */
  const evictOne = (queue: QueuedMessage[], isGroup: boolean): QueuedMessage | undefined => {
    if (isGroup) {
      const botIdx = queue.findIndex(m => m.senderIsBot);
      if (botIdx >= 0) return queue.splice(botIdx, 1)[0];
    }
    return queue.shift();
  };

  /** 判断消息是否为斜杠指令 */
  const isSlashCommand = (msg: QueuedMessage): boolean =>
    (msg.content ?? "").trim().startsWith("/");

  /** 处理单条消息，捕获异常并记录日志 */
  const processOne = async (
    msg: QueuedMessage,
    peerId: string,
    label: string,
  ): Promise<boolean> => {
    try {
      await handleMessageFnRef!(msg);
      return true;
    } catch (err) {
      log?.error(`[qqbot:${accountId}] ${label} error for ${peerId}: ${err}`);
      return false;
    }
  };

  /** 批量处理群聊排队消息：斜杠指令逐条处理，普通消息合并后处理 */
  const drainGroupBatch = async (all: QueuedMessage[], peerId: string): Promise<void> => {
    const commands: QueuedMessage[] = [];
    const normal: QueuedMessage[] = [];
    for (const m of all) {
      (isSlashCommand(m) ? commands : normal).push(m);
    }

    // 指令消息逐条处理
    for (const cmd of commands) {
      log?.info(`[qqbot:${accountId}] Processing command independently for ${peerId}: ${(cmd.content ?? "").trim().slice(0, 50)}`);
      await processOne(cmd, peerId, "Command processor");
    }

    // 普通消息合并后处理
    if (normal.length > 0) {
      const merged = mergeGroupMessages(normal);
      if (normal.length > 1) {
        log?.info(`[qqbot:${accountId}] Merged ${normal.length} queued group messages for ${peerId} into one`);
      }
      await processOne(merged, peerId, `Message processor (merged batch of ${normal.length})`);
    }
  };

  /** 处理指定 peer 队列中的消息（串行） */
  const drainUserQueue = async (peerId: string): Promise<void> => {
    if (activeUsers.has(peerId)) return;
    if (activeUsers.size >= maxConcurrentUsers) {
      log?.info(`[qqbot:${accountId}] Max concurrent users (${maxConcurrentUsers}) reached, ${peerId} will wait`);
      return;
    }

    const queue = userQueues.get(peerId);
    if (!queue || queue.length === 0) {
      userQueues.delete(peerId);
      return;
    }

    activeUsers.add(peerId);
    const isGroup = isGroupPeer(peerId);

    try {
      while (queue.length > 0 && !ctx.isAborted()) {
        // 群聊排队 > 1 条：批量处理
        if (isGroup && queue.length > 1 && handleMessageFnRef) {
          const all = queue.splice(0, queue.length);
          totalEnqueued = Math.max(0, totalEnqueued - all.length);
          await drainGroupBatch(all, peerId);
          continue;
        }

        // 非群聊 或 队列只剩 1 条：逐条处理
        const msg = queue.shift()!;
        totalEnqueued = Math.max(0, totalEnqueued - 1);
        if (handleMessageFnRef) {
          await processOne(msg, peerId, "Message processor");
        }
      }
    } finally {
      activeUsers.delete(peerId);
      userQueues.delete(peerId);
      // 尽量填满并发槽位
      for (const [waitingPeerId, waitingQueue] of userQueues) {
        if (activeUsers.size >= maxConcurrentUsers) break;
        if (waitingQueue.length > 0 && !activeUsers.has(waitingPeerId)) {
          drainUserQueue(waitingPeerId);
        }
      }
    }
  };

  const enqueue = (msg: QueuedMessage): void => {
    const peerId = getMessagePeerId(msg);
    const isGroup = isGroupPeer(peerId);
    let queue = userQueues.get(peerId);
    if (!queue) {
      queue = [];
      userQueues.set(peerId, queue);
    }

    // 群聊和非群聊使用不同的队列上限
    const maxSize = isGroup ? groupQueueSize : peerQueueSize;

    // 队列溢出：淘汰一条旧消息
    if (queue.length >= maxSize) {
      const dropped = evictOne(queue, isGroup);
      totalEnqueued = Math.max(0, totalEnqueued - 1);
      if (isGroup && dropped?.senderIsBot) {
        log?.info(`[qqbot:${accountId}] Queue full for ${peerId}, dropping bot message ${dropped.messageId}`);
      } else {
        log?.error(`[qqbot:${accountId}] Queue full for ${peerId}, dropping oldest message ${dropped?.messageId}`);
      }
    }

    // 全局总量保护
    totalEnqueued++;
    if (totalEnqueued > globalQueueSize) {
      log?.error(`[qqbot:${accountId}] Global queue limit reached (${totalEnqueued}), message from ${peerId} may be delayed`);
    }

    queue.push(msg);
    log?.debug?.(`[qqbot:${accountId}] Message enqueued for ${peerId}, user queue: ${queue.length}, active users: ${activeUsers.size}`);

    // 如果该用户没有正在处理的消息，立即启动处理
    drainUserQueue(peerId);
  };

  const startProcessor = (handleMessageFn: (msg: QueuedMessage) => Promise<void>): void => {
    handleMessageFnRef = handleMessageFn;
    log?.info(`[qqbot:${accountId}] Message processor started (per-user concurrency, max ${maxConcurrentUsers} users)`);
  };

  const getSnapshot = (senderPeerId: string): QueueSnapshot => {
    let totalPending = 0;
    for (const [, q] of userQueues) {
      totalPending += q.length;
    }
    const senderQueue = userQueues.get(senderPeerId);
    return {
      totalPending,
      activeUsers: activeUsers.size,
      maxConcurrentUsers,
      senderPending: senderQueue ? senderQueue.length : 0,
    };
  };

  const clearUserQueue = (peerId: string): number => {
    const queue = userQueues.get(peerId);
    if (!queue || queue.length === 0) return 0;
    const droppedCount = queue.length;
    queue.length = 0;
    totalEnqueued = Math.max(0, totalEnqueued - droppedCount);
    return droppedCount;
  };

  const executeImmediate = (msg: QueuedMessage): void => {
    if (handleMessageFnRef) {
      handleMessageFnRef(msg).catch(err => {
        log?.error(`[qqbot:${accountId}] Immediate execution error: ${err}`);
      });
    }
  };

  return { enqueue, startProcessor, getSnapshot, getMessagePeerId, clearUserQueue, executeImmediate };
}
