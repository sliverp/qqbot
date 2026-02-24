/**
 * Gateway 入站消息组装
 * 将 QQ 消息事件转换为 openclaw inbound context
 */

import path from "node:path";
import type { ResolvedQQBotAccount } from "./types.js";
import { downloadFile } from "./image-server.js";
import { parseFaceTags } from "./utils/text.js";
import { isVoiceAttachment, convertSilkToWav, formatDuration } from "./utils/audio-convert.js";

export interface InboundMessageEvent {
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

export interface InboundBuildResult {
  /** 用于 formatInboundEnvelope 的 body（仅用户原始内容 + 附件描述） */
  userContent: string;
  /** AI 可见的完整上下文（系统提示 + 上下文 + 用户内容） */
  agentBody: string;
  /** 原始 messageBody（系统提示 + 用户输入） */
  messageBody: string;
  /** 本地图片路径 */
  localMediaPaths: string[];
  localMediaTypes: string[];
  /** 远程图片 URL */
  remoteMediaUrls: string[];
  remoteMediaTypes: string[];
  /** from 地址 */
  fromAddress: string;
  /** 是否群聊 */
  isGroup: boolean;
  /** 投递目标地址 */
  targetAddress: string;
  /** 命令是否已授权 */
  commandAuthorized: boolean;
}

const DOWNLOAD_DIR = path.join(process.env.HOME || "/home/ubuntu", ".openclaw", "qqbot", "downloads");

/**
 * 处理附件（图片/语音/其他），返回附件描述和媒体信息
 */
async function processAttachments(
  attachments: Array<{ content_type: string; url: string; filename?: string }>,
  messageId: string,
  log?: { info: (msg: string) => void; error: (msg: string) => void },
  accountId?: string,
): Promise<{
  attachmentInfo: string;
  imageUrls: string[];
  imageMediaTypes: string[];
}> {
  const imageUrls: string[] = [];
  const imageMediaTypes: string[] = [];
  const imageDescriptions: string[] = [];
  const voiceDescriptions: string[] = [];
  const otherAttachments: string[] = [];

  for (const att of attachments) {
    const localPath = await downloadFile(att.url, DOWNLOAD_DIR, att.filename);
    if (localPath) {
      if (att.content_type?.startsWith("image/")) {
        imageUrls.push(localPath);
        imageMediaTypes.push(att.content_type);

        const format = att.content_type?.split("/")[1] || "未知格式";
        const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

        imageDescriptions.push(`
用户发送了一张图片：
- 图片地址：${localPath}
- 图片格式：${format}
- 消息ID：${messageId}
- 发送时间：${timestamp}

请根据图片内容进行回复。`);
      } else if (isVoiceAttachment(att)) {
        log?.info(`[qqbot:${accountId}] Voice attachment detected: ${att.filename}, converting SILK to WAV...`);
        try {
          const result = await convertSilkToWav(localPath, DOWNLOAD_DIR);
          if (result) {
            const durationStr = formatDuration(result.duration);
            log?.info(`[qqbot:${accountId}] Voice converted: ${result.wavPath} (duration: ${durationStr})`);
            const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
            voiceDescriptions.push(`
用户发送了一条语音消息：
- 语音文件：${result.wavPath}
- 语音时长：${durationStr}
- 发送时间：${ts}`);
          } else {
            log?.info(`[qqbot:${accountId}] Voice file is not SILK format, keeping original: ${localPath}`);
            voiceDescriptions.push(`
用户发送了一条语音消息（非SILK格式，无法转换）：
- 语音文件：${localPath}
- 原始格式：${att.filename || "unknown"}
- 消息ID：${messageId}

请告知用户该语音格式暂不支持解析。`);
          }
        } catch (convertErr) {
          log?.error(`[qqbot:${accountId}] Voice conversion failed: ${convertErr}`);
          voiceDescriptions.push(`
用户发送了一条语音消息（转换失败）：
- 原始文件：${localPath}
- 错误信息：${convertErr}
- 消息ID：${messageId}

请告知用户语音处理出现问题。`);
        }
      } else {
        otherAttachments.push(`[附件: ${localPath}]`);
      }
      log?.info(`[qqbot:${accountId}] Downloaded attachment to: ${localPath}`);
    } else {
      log?.error(`[qqbot:${accountId}] Failed to download attachment: ${att.url}`);
      if (att.content_type?.startsWith("image/")) {
        imageUrls.push(att.url);
        imageMediaTypes.push(att.content_type);
        const format = att.content_type?.split("/")[1] || "未知格式";
        const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
        imageDescriptions.push(`
用户发送了一张图片（下载失败，使用原始URL）：
- 图片地址：${att.url}
- 图片格式：${format}
- 消息ID：${messageId}
- 发送时间：${ts}

请根据图片内容进行回复。`);
      } else {
        otherAttachments.push(`[附件: ${att.filename ?? att.content_type}] (下载失败)`);
      }
    }
  }

  let attachmentInfo = "";
  if (imageDescriptions.length > 0) attachmentInfo += "\n" + imageDescriptions.join("\n");
  if (voiceDescriptions.length > 0) attachmentInfo += "\n" + voiceDescriptions.join("\n");
  if (otherAttachments.length > 0) attachmentInfo += "\n" + otherAttachments.join("\n");

  return { attachmentInfo, imageUrls, imageMediaTypes };
}

/**
 * 构建动态上下文信息（注入到 agent body）
 */
function buildContextInfo(
  event: InboundMessageEvent,
  isGroupChat: boolean,
  targetAddress: string,
): string {
  const nowMs = Date.now();
  return `你正在通过 QQ 与用户对话。

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
}

/**
 * 从消息事件构建完整的入站上下文
 */
export async function buildInboundMessage(
  event: InboundMessageEvent,
  account: ResolvedQQBotAccount,
  log?: { info: (msg: string) => void; error: (msg: string) => void },
): Promise<InboundBuildResult> {
  const isGroupChat = event.type === "group";
  const targetAddress = isGroupChat ? `group:${event.groupOpenid}` : event.senderId;
  const isGroup = event.type === "guild" || event.type === "group";

  // 系统提示词
  const systemPrompts: string[] = [];
  if (account.systemPrompt) {
    systemPrompts.push(account.systemPrompt);
  }

  // 处理附件
  let attachmentInfo = "";
  let imageUrls: string[] = [];
  let imageMediaTypes: string[] = [];

  if (event.attachments?.length) {
    const result = await processAttachments(
      event.attachments, event.messageId, log, account.accountId,
    );
    attachmentInfo = result.attachmentInfo;
    imageUrls = result.imageUrls;
    imageMediaTypes = result.imageMediaTypes;
  }

  // 解析表情标签
  const parsedContent = parseFaceTags(event.content);
  const userContent = parsedContent + attachmentInfo;
  let messageBody = `【系统提示】\n${systemPrompts.join("\n")}\n\n【用户输入】\n${userContent}`;

  if (userContent.startsWith("/")) {
    messageBody = userContent;
  }

  // 构建 agent 上下文
  const contextInfo = buildContextInfo(event, isGroupChat, targetAddress);
  const agentBody = systemPrompts.length > 0
    ? `${contextInfo}\n\n${systemPrompts.join("\n")}\n\n${userContent}`
    : `${contextInfo}\n\n${userContent}`;

  // from 地址
  const fromAddress = event.type === "guild" ? `qqbot:channel:${event.channelId}`
                     : event.type === "group" ? `qqbot:group:${event.groupOpenid}`
                     : `qqbot:c2c:${event.senderId}`;

  // 命令授权
  const allowFromList = account.config?.allowFrom ?? [];
  const allowAll = allowFromList.length === 0 || allowFromList.some((entry: string) => entry === "*");
  const commandAuthorized = allowAll || allowFromList.some((entry: string) =>
    entry.toUpperCase() === event.senderId.toUpperCase()
  );

  // 分离本地路径和远程 URL
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

  return {
    userContent,
    agentBody,
    messageBody,
    localMediaPaths,
    localMediaTypes,
    remoteMediaUrls,
    remoteMediaTypes,
    fromAddress,
    isGroup,
    targetAddress,
    commandAuthorized,
  };
}
