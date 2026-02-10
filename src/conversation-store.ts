/**
 * 对话历史追踪存储
 * 用于判断是否是与某个用户/群组的首次对话
 */

import fs from "node:fs";
import path from "node:path";

// 对话状态接口
export interface ConversationState {
    /** 对话 ID (userId 或 groupId) */
    conversationId: string;
    /** 是否是新对话 */
    isNewConversation: boolean;
    /** 首次对话的时间戳 */
    firstMessageAt: number;
    /** 最后活动时间 */
    lastMessageAt: number;
    /** 保存时间 */
    savedAt: number;
}

// 对话数据目录
const CONVERSATION_DIR = path.join(
    process.env.HOME || "/tmp",
    "clawd",
    "qqbot-data"
);
console.log(`[qqbot-CONVERSATION_DIR] = ${CONVERSATION_DIR}`);

// 对话过期时间（15天）- 超过这个时间认为是新会话
const CONVERSATION_EXPIRE_TIME = 15 * 24 * 60 * 60 * 1000;

// 内存缓存
const conversationCache = new Map<string, ConversationState>();

/**
 * 确保目录存在
 */
function ensureDir(): void {
    if (!fs.existsSync(CONVERSATION_DIR)) {
        fs.mkdirSync(CONVERSATION_DIR, { recursive: true });
    }
}

/**
 * 获取对话数据文件路径
 */
function getConversationPath(conversationId: string): string {
    // 清理 ID 中的特殊字符
    const safeId = conversationId.replace(/[^a-zA-Z0-9_:\-\.]/g, "_");
    return path.join(CONVERSATION_DIR, `conversation-${safeId}.json`);
}

/**
 * 检查对话是否是新的
 * @param conversationId 对话 ID (userId 或 group:groupId)
 * @returns true 表示是新对话，false 表示是继续对话
 */
export function checkConversationStatus(conversationId: string): boolean {
    // 检查内存缓存
    if (conversationCache.has(conversationId)) {
        const cached = conversationCache.get(conversationId)!;
        const now = Date.now();

        // 如果距离上次消息超过过期时间，认为是新会话
        if (now - cached.lastMessageAt > CONVERSATION_EXPIRE_TIME) {
            cached.isNewConversation = true;
            cached.firstMessageAt = now;
            cached.lastMessageAt = now;
            cached.savedAt = now;
            saveConversationState(conversationId, cached);
            return true;
        }

        // 获取当前对话的新旧状态
        const isNew = cached.isNewConversation;

        // 更新最后活动时间，并将标志改为 false（表示已处理过）
        cached.lastMessageAt = now;
        cached.isNewConversation = false;
        cached.savedAt = now;
        saveConversationState(conversationId, cached);

        return isNew;
    }

    // 检查文件存储
    const filePath = getConversationPath(conversationId);
    const now = Date.now();

    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, "utf-8");
            const state = JSON.parse(data) as ConversationState;

            // 检查是否过期
            if (now - state.lastMessageAt > CONVERSATION_EXPIRE_TIME) {
                // 对话过期，认为是新会话
                const newState: ConversationState = {
                    conversationId,
                    isNewConversation: true,
                    firstMessageAt: now,
                    lastMessageAt: now,
                    savedAt: now,
                };
                conversationCache.set(conversationId, newState);
                saveConversationState(conversationId, newState);
                return true;
            }

            // 获取当前的新旧状态
            const isNew = state.isNewConversation;

            // 更新最后活动时间，并将标志改为 false（表示已处理过）
            state.lastMessageAt = now;
            state.isNewConversation = false;
            state.savedAt = now;
            conversationCache.set(conversationId, state);
            saveConversationState(conversationId, state);

            return isNew;
        }
    } catch (err) {
        console.log(`[conversation-store] Error reading conversation for ${conversationId}: ${err}`);
    }

    // 文件不存在，这是新对话
    const newState: ConversationState = {
        conversationId,
        isNewConversation: true,
        firstMessageAt: now,
        lastMessageAt: now,
        savedAt: now,
    };
    conversationCache.set(conversationId, newState);
    saveConversationState(conversationId, newState);
    return true;
}

/**
 * 保存对话状态到文件
 */
function saveConversationState(conversationId: string, state: ConversationState): void {
    ensureDir();
    const filePath = getConversationPath(conversationId);

    try {
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
    } catch (err) {
        console.error(`[conversation-store] Error saving conversation state for ${conversationId}: ${err}`);
    }
}

/**
 * 清除所有对话历史（用于测试或重置）
 */
export function clearAllConversations(): void {
    conversationCache.clear();

    try {
        if (fs.existsSync(CONVERSATION_DIR)) {
            const files = fs.readdirSync(CONVERSATION_DIR);
            for (const file of files) {
                if (file.startsWith("conversation-")) {
                    fs.unlinkSync(path.join(CONVERSATION_DIR, file));
                }
            }
        }
    } catch (err) {
        console.error(`[conversation-store] Error clearing conversations: ${err}`);
    }
}

