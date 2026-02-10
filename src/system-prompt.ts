/**
 * 系统提示词生成模块
 * 根据会话状态生成相应的系统提示词
 * 支持首次详细和后续精简两种模式
 */

import { checkConversationStatus } from "./conversation-store.js";

export interface SystemPromptOptions {
    /** 事件类型 */
    eventType: "c2c" | "guild" | "dm" | "group";
    /** 发送者 ID */
    senderId: string;
    /** 发送者昵称 */
    senderName?: string;
    /** 消息 ID */
    messageId: string;
    /** 消息时间戳 */
    timestamp: string;
    /** 群组 openid（仅当 eventType 为 group 时） */
    groupOpenid?: string;
}

/**
 * 生成系统内置提示词
 * @param options 选项对象
 * @returns 生成的系统提示词
 */
export function generateBuiltinPrompt(options: SystemPromptOptions): string {
    const {
        eventType,
        senderId,
        senderName,
        messageId,
        timestamp,
        groupOpenid,
    } = options;

    // 判断是否是群聊
    const isGroupChat = eventType === "group";

    // 构建目标地址（用于定时提醒）
    const targetAddress = isGroupChat ? `group:${groupOpenid}` : senderId;

    // 构建会话 ID（用于判断是否是新会话）
    const conversationId = isGroupChat ? `group:${groupOpenid}` : senderId;

    // 检查是否是新会话
    const isNewConversation = checkConversationStatus(conversationId);

    // 格式化时间戳为 HH:MM
    const messageTime = new Date(timestamp).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });

    let builtinPrompt = "";

    // 【首次对话】显示详细信息
    console.info(`[qqbot:system-prompt] ${conversationId}:${isNewConversation}`);
    if (isNewConversation) {
        builtinPrompt = `
【新会话】用户: ${senderName || senderId} (ID: ${senderId}) | ${isGroupChat ? "QQ群聊" : "QQ私聊"}

【可用能力】
• 定时提醒 - 使用 openclaw cron add --at "5m" --message "内容" --to "${targetAddress}"
• 发送图片 - <qqimg>路径</qqimg>

【当前用户信息】
- 用户 openid: ${senderId}
- 用户昵称: ${senderName || "未知"}
- 消息类型: ${isGroupChat ? "群聊" : "私聊"}
- 当前消息 message_id: ${messageId}${isGroupChat ? `
- 群组 group_openid: ${groupOpenid}` : ""}

【定时提醒能力详解】
你可以帮助用户设置定时提醒。使用exec工具运行 openclaw cron 命令：
示例：5分钟后提醒用户喝水
\`\`\`bash
openclaw cron add \\
  --name "提醒喝水-${senderName || "用户"}" \\
  --at "5m" \\
  --session isolated \\
  --message "💧 该喝水啦！" \\
  --deliver \\
  --channel qqbot \\
  --to "${targetAddress}" \\
  --delete-after-run
\`\`\`

关键参数说明：
- \`--to\`: 目标地址（当前用户: ${targetAddress}）
- \`--at\`: 一次性定时任务的触发时间
  - 相对时间格式：数字+单位，如 \`5m\`（5分钟）、\`1h\`（1小时）、\`2d\`（2天）【注意：不要加 + 号】
  - 绝对时间格式：ISO 8601 带时区，如 \`2026-02-01T14:00:00+08:00\`
- \`--cron\`: 周期性任务（如 \`0 8 * * *\` 每天早上8点）
- \`--tz "Asia/Shanghai"\`: 周期任务务必设置时区
- \`--delete-after-run\`: 一次性任务必须添加此参数
- \`--message\`: 消息内容（必填，不能为空！这是定时提醒触发时直接发送给用户的内容）
- \`--session isolated\` 独立会话任务

重要注意事项：
1. --at 参数格式：相对时间用 \`5m\`、\`1h\` 等（不要加 + 号！）；绝对时间用完整 ISO 格式
2. --message 参数必须有实际内容，不能为空字符串
3. cron add 命令不支持 --reply-to 参数，定时提醒只能作为主动消息发送

【发送图片功能】
你可以直接发送图片给用户！使用 <qqimg> 标签包裹图片路径：

<qqimg>图片路径</qqimg>

示例：
- <qqimg>/Users/xxx/images/photo.jpg</qqimg>  （本地文件）
- <qqimg>https://example.com/image.png</qqimg>  （网络图片）

注意：
- 必须使用 <qqimg>路径</qqimg> 格式
- 本地路径必须是绝对路径，支持 png、jpg、jpeg、gif、webp 格式
- 图片文件/URL 必须有效，否则发送失败
- Markdown格式下，也必须使用该方式发送图片`;
    }


    // 【后续对话】显示精简信息
    else {
        builtinPrompt = `
【继续活跃会话】${senderName} | ${senderId} | ${messageTime}

【可用指令提示】需要时使用: openclaw cron add --at "5m" --message "内容" --to "${targetAddress}"

【可用图片能力】<qqimg>路径</qqimg>`;

    }

    return builtinPrompt;
}

