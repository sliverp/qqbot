/**
 * QQBot 插件级斜杠指令处理器
 *
 * 设计原则：
 * 1. 在消息入队前拦截，匹配到插件级指令后直接回复，不进入 AI 处理队列
 * 2. 不匹配的 "/" 消息照常入队，交给 OpenClaw 框架处理
 * 3. 每个指令通过 SlashCommand 接口注册，易于扩展
 *
 * 时间线追踪：
 *   开平推送时间戳 → 插件收到(Date.now()) → 指令处理完成(Date.now())
 *   从而计算「开平→插件」和「插件处理」两段耗时
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// 读取 package.json 中的版本号
let PLUGIN_VERSION = "unknown";
try {
  const pkg = require("../package.json");
  PLUGIN_VERSION = pkg.version ?? "unknown";
} catch {
  // fallback
}

// ============ 类型定义 ============

/** 斜杠指令上下文（消息元数据 + 运行时状态） */
export interface SlashCommandContext {
  /** 消息类型 */
  type: "c2c" | "guild" | "dm" | "group";
  /** 发送者 ID */
  senderId: string;
  /** 发送者昵称 */
  senderName?: string;
  /** 消息 ID（用于被动回复） */
  messageId: string;
  /** 开平推送的事件时间戳（ISO 字符串） */
  eventTimestamp: string;
  /** 插件收到消息的本地时间（ms） */
  receivedAt: number;
  /** 原始消息内容 */
  rawContent: string;
  /** 指令参数（去掉指令名后的部分） */
  args: string;
  /** 频道 ID（guild 类型） */
  channelId?: string;
  /** 群 openid（group 类型） */
  groupOpenid?: string;
  /** 账号 ID */
  accountId: string;
  /** 当前用户队列状态快照 */
  queueSnapshot: QueueSnapshot;
}

/** 队列状态快照 */
export interface QueueSnapshot {
  /** 各用户队列中的消息总数 */
  totalPending: number;
  /** 正在并行处理的用户数 */
  activeUsers: number;
  /** 最大并发用户数 */
  maxConcurrentUsers: number;
  /** 当前发送者在队列中的待处理消息数 */
  senderPending: number;
}

/** 斜杠指令返回值：直接回复文本，null 表示不处理（交给框架） */
type SlashCommandResult = string | null;

/** 斜杠指令定义 */
interface SlashCommand {
  /** 指令名（不含 /） */
  name: string;
  /** 简要描述 */
  description: string;
  /** 处理函数 */
  handler: (ctx: SlashCommandContext) => SlashCommandResult | Promise<SlashCommandResult>;
}

// ============ 指令注册表 ============

const commands: Map<string, SlashCommand> = new Map();

function registerCommand(cmd: SlashCommand): void {
  commands.set(cmd.name.toLowerCase(), cmd);
}

// ============ 内置指令 ============

/**
 * /echo — 诊断指令
 * 回复：插件版本、链路耗时（开平→插件、插件处理）、当前用户队列状态
 */
registerCommand({
  name: "echo",
  description: "诊断信息：版本、链路耗时、队列状态",
  handler: (ctx) => {
    const now = Date.now();
    const eventTime = new Date(ctx.eventTimestamp).getTime();
    const platformToPlugin = isNaN(eventTime) ? "N/A" : `${ctx.receivedAt - eventTime}ms`;
    const pluginProcessing = `${now - ctx.receivedAt}ms`;

    const lines = [
      `**qqbot plugin** v${PLUGIN_VERSION}`,
      ``,
      `**链路耗时**`,
      `- 平台 → 插件: ${platformToPlugin}`,
      `- 插件处理: ${pluginProcessing}`,
      ``,
      `**队列状态**`,
      `- 当前待处理: ${ctx.queueSnapshot.senderPending}`,
      `- 全局待处理: ${ctx.queueSnapshot.totalPending}`,
    ];
    return lines.join("\n");
  },
});

/**
 * /ping — 轻量连通性检查
 */
registerCommand({
  name: "ping",
  description: "连通性检查",
  handler: (ctx) => {
    const now = Date.now();
    const eventTime = new Date(ctx.eventTimestamp).getTime();
    const latency = isNaN(eventTime) ? "N/A" : `${now - eventTime}ms`;
    return `🏓 pong! (${latency})`;
  },
});

/**
 * /version — 版本号
 */
registerCommand({
  name: "version",
  description: "插件版本号",
  handler: () => {
    return `QQBot Plugin v${PLUGIN_VERSION}`;
  },
});

/**
 * /help — 列出所有插件级斜杠指令
 */
registerCommand({
  name: "help",
  description: "列出所有插件级斜杠指令",
  handler: () => {
    const lines = [`**qqbot 插件指令列表**`, ``];
    for (const [name, cmd] of commands) {
      lines.push(`- \`/${name}\` — ${cmd.description}`);
    }
    lines.push(``, `其他 "/" 开头的消息将由 AI 框架处理。`);
    return lines.join("\n");
  },
});

// ============ 匹配入口 ============

/**
 * 尝试匹配并执行插件级斜杠指令
 *
 * @returns 回复文本（匹配成功），null（不匹配，应入队正常处理）
 */
export async function matchSlashCommand(ctx: SlashCommandContext): Promise<string | null> {
  const content = ctx.rawContent.trim();
  if (!content.startsWith("/")) return null;

  // 解析指令名和参数
  const spaceIdx = content.indexOf(" ");
  const cmdName = (spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

  const cmd = commands.get(cmdName);
  if (!cmd) return null; // 不是插件级指令，交给框架

  ctx.args = args;
  const result = await cmd.handler(ctx);
  return result;
}

/** 获取插件版本号（供外部使用） */
export function getPluginVersion(): string {
  return PLUGIN_VERSION;
}
