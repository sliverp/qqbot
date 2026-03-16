import { Type } from "@sinclair/typebox";
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { sendMedia } from "./outbound.js";
import { getCurrentQQBotAccount } from "./runtime.js";

/**
 * QQBot 媒体发送工具
 * 用于让 AI 直接调用工具发送图片、视频、文件、语音
 */

/**
 * 创建发送图片的工具
 */
export function createQQBotSendImageTool(): ChannelAgentTool {
  return {
    label: "QQBot Send Image",
    name: "qqbot_send_image",
    description: "发送图片到 QQ 私聊或群聊。支持公网 URL 或本地文件路径。",
    parameters: Type.Object({
      target: Type.String({ description: "目标地址，格式: c2c:openid (私聊) 或 group:groupid (群聊)" }),
      imageUrl: Type.String({ description: "图片 URL 或本地文件路径" }),
      text: Type.Optional(Type.String({ description: "随图片发送的文本消息" })),
    }),
    execute: async (_toolCallId, args) => {
      const { target, imageUrl, text } = args as { target?: string; imageUrl?: string; text?: string };

      if (!target) {
        return {
          content: [{ type: "text", text: "错误: target 是必填参数" }],
          isError: true,
        };
      }

      if (!imageUrl) {
        return {
          content: [{ type: "text", text: "错误: imageUrl 是必填参数" }],
          isError: true,
        };
      }

      try {
        // 直接从 runtime 获取已解析的 account 对象
        const account = getCurrentQQBotAccount();

        if (!account) {
          return {
            content: [{ type: "text", text: "错误: QQBot 未启动或未配置" }],
            isError: true,
          };
        }

        if (!account.appId || !account.clientSecret) {
          return {
            content: [{ type: "text", text: "错误: QQBot 未配置 (缺少 appId 或 clientSecret)" }],
            isError: true,
          };
        }

        const result = await sendMedia({
          to: target,
          text: text ?? "",
          mediaUrl: imageUrl,
          accountId: account.accountId,
          replyToId: undefined,
          account,
        });

        if (result.error) {
          return {
            content: [{ type: "text", text: `发送图片失败: ${result.error}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `图片发送成功! 消息ID: ${result.messageId}` }],
          details: { messageId: result.messageId, target, imageUrl },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `发送图片失败: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  };
}

/**
 * 创建发送视频的工具
 */
export function createQQBotSendVideoTool(): ChannelAgentTool {
  return {
    label: "QQBot Send Video",
    name: "qqbot_send_video",
    description: "发送视频到 QQ 私聊或群聊。支持公网 URL 或本地文件路径。",
    parameters: Type.Object({
      target: Type.String({ description: "目标地址，格式: c2c:openid (私聊) 或 group:groupid (群聊)" }),
      videoUrl: Type.String({ description: "视频 URL 或本地文件路径" }),
      text: Type.Optional(Type.String({ description: "随视频发送的文本消息" })),
    }),
    execute: async (_toolCallId, args) => {
      const { target, videoUrl, text } = args as { target?: string; videoUrl?: string; text?: string };

      if (!target) {
        return {
          content: [{ type: "text", text: "错误: target 是必填参数" }],
          isError: true,
        };
      }

      if (!videoUrl) {
        return {
          content: [{ type: "text", text: "错误: videoUrl 是必填参数" }],
          isError: true,
        };
      }

      try {
        // 直接从 runtime 获取已解析的 account 对象
        const account = getCurrentQQBotAccount();

        if (!account) {
          return {
            content: [{ type: "text", text: "错误: QQBot 未启动或未配置" }],
            isError: true,
          };
        }

        if (!account.appId || !account.clientSecret) {
          return {
            content: [{ type: "text", text: "错误: QQBot 未配置 (缺少 appId 或 clientSecret)" }],
            isError: true,
          };
        }

        const result = await sendMedia({
          to: target,
          text: text ?? "",
          mediaUrl: videoUrl,
          accountId: account.accountId,
          replyToId: undefined,
          account,
        });

        if (result.error) {
          return {
            content: [{ type: "text", text: `发送视频失败: ${result.error}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `视频发送成功! 消息ID: ${result.messageId}` }],
          details: { messageId: result.messageId, target, videoUrl },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `发送视频失败: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  };
}

/**
 * 创建发送文件的工具
 */
export function createQQBotSendFileTool(): ChannelAgentTool {
  return {
    label: "QQBot Send File",
    name: "qqbot_send_file",
    description: "发送文件到 QQ 私聊或群聊。支持公网 URL 或本地文件路径。适用于 PDF、文档、压缩包等非图片非视频文件。",
    parameters: Type.Object({
      target: Type.String({ description: "目标地址，格式: c2c:openid (私聊) 或 group:groupid (群聊)" }),
      fileUrl: Type.String({ description: "文件 URL 或本地文件路径" }),
      text: Type.Optional(Type.String({ description: "随文件发送的文本消息" })),
    }),
    execute: async (_toolCallId, args) => {
      const { target, fileUrl, text } = args as { target?: string; fileUrl?: string; text?: string };

      if (!target) {
        return {
          content: [{ type: "text", text: "错误: target 是必填参数" }],
          isError: true,
        };
      }

      if (!fileUrl) {
        return {
          content: [{ type: "text", text: "错误: fileUrl 是必填参数" }],
          isError: true,
        };
      }

      try {
        // 直接从 runtime 获取已解析的 account 对象
        const account = getCurrentQQBotAccount();

        if (!account) {
          return {
            content: [{ type: "text", text: "错误: QQBot 未启动或未配置" }],
            isError: true,
          };
        }

        if (!account.appId || !account.clientSecret) {
          return {
            content: [{ type: "text", text: "错误: QQBot 未配置 (缺少 appId 或 clientSecret)" }],
            isError: true,
          };
        }

        const result = await sendMedia({
          to: target,
          text: text ?? "",
          mediaUrl: fileUrl,
          accountId: account.accountId,
          replyToId: undefined,
          account,
        });

        if (result.error) {
          return {
            content: [{ type: "text", text: `发送文件失败: ${result.error}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `文件发送成功! 消息ID: ${result.messageId}` }],
          details: { messageId: result.messageId, target, fileUrl },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `发送文件失败: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  };
}

/**
 * 创建发送语音的工具
 */
export function createQQBotSendVoiceTool(): ChannelAgentTool {
  return {
    label: "QQBot Send Voice",
    name: "qqbot_send_voice",
    description: "发送语音到 QQ 私聊或群聊。支持公网 URL 或本地文件路径。",
    parameters: Type.Object({
      target: Type.String({ description: "目标地址，格式: c2c:openid (私聊) 或 group:groupid (群聊)" }),
      voiceUrl: Type.String({ description: "语音文件 URL 或本地文件路径" }),
      text: Type.Optional(Type.String({ description: "随语音发送的文本消息" })),
    }),
    execute: async (_toolCallId, args) => {
      const { target, voiceUrl, text } = args as { target?: string; voiceUrl?: string; text?: string };

      if (!target) {
        return {
          content: [{ type: "text", text: "错误: target 是必填参数" }],
          isError: true,
        };
      }

      if (!voiceUrl) {
        return {
          content: [{ type: "text", text: "错误: voiceUrl 是必填参数" }],
          isError: true,
        };
      }

      try {
        // 直接从 runtime 获取已解析的 account 对象
        const account = getCurrentQQBotAccount();

        if (!account) {
          return {
            content: [{ type: "text", text: "错误: QQBot 未启动或未配置" }],
            isError: true,
          };
        }

        if (!account.appId || !account.clientSecret) {
          return {
            content: [{ type: "text", text: "错误: QQBot 未配置 (缺少 appId 或 clientSecret)" }],
            isError: true,
          };
        }

        const result = await sendMedia({
          to: target,
          text: text ?? "",
          mediaUrl: voiceUrl,
          accountId: account.accountId,
          replyToId: undefined,
          account,
        });

        if (result.error) {
          return {
            content: [{ type: "text", text: `发送语音失败: ${result.error}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `语音发送成功! 消息ID: ${result.messageId}` }],
          details: { messageId: result.messageId, target, voiceUrl },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `发送语音失败: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  };
}

/**
 * 获取所有 QQBot 工具
 */
export function getQQBotTools(): ChannelAgentTool[] {
  return [
    createQQBotSendImageTool(),
    createQQBotSendVideoTool(),
    createQQBotSendFileTool(),
    createQQBotSendVoiceTool(),
  ];
}
