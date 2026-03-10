/**
 * QQ Bot 流式发送上下文管理
 * 
 * 处理大模型流式响应的缓冲、分段和发送逻辑
 */

import type { ResolvedQQBotAccount } from "./types.js";
import {
  getAccessToken,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
} from "./api.js";

/**
 * 解析目标地址格式
 */
function parseTarget(to: string): { type: "c2c" | "group" | "channel"; id: string } {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [qqbot-stream] parseTarget: input=${to}`);
  
  let id = to.replace(/^qqbot:/i, "");
  
  if (id.startsWith("c2c:")) {
    return { type: "c2c", id: id.slice(4) };
  } else if (id.startsWith("group:")) {
    return { type: "group", id: id.slice(6) };
  } else if (id.startsWith("channel:")) {
    return { type: "channel", id: id.slice(8) };
  } else {
    // 假定是 c2c
    return { type: "c2c", id };
  }
}

/**
 * 简单 sleep 函数
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * QQ Bot 流式发送上下文
 * 
 * 用于在大模型流式生成时，将 token 逐步发送到 QQ
 */
export class QQBotStreamContext {
  private account: ResolvedQQBotAccount;
  private to: string;
  private replyToId?: string | null;
  
  // 缓冲和分片管理
  private buffer: string = "";
  private sentChunks: string[] = [];
  private streamId: string | undefined;
  private messageId: string | undefined;
  private accessToken: string | undefined;
  
  // 配置参数
  private chunkSize: number = 50; // 字符数，缓冲满时发送
  private sendInterval: number = 100; // 毫秒，发送之间的延迟
  
  // 状态追踪
  private initialized: boolean = false;
  private finalized: boolean = false;
  private totalTokens: number = 0;

  /**
   * 构造函数
   */
  constructor(
    account: ResolvedQQBotAccount,
    to: string,
    replyToId?: string | null,
    options?: { chunkSize?: number; sendInterval?: number }
  ) {
    this.account = account;
    this.to = to;
    this.replyToId = replyToId;
    
    if (options?.chunkSize) this.chunkSize = options.chunkSize;
    if (options?.sendInterval) this.sendInterval = options.sendInterval;
    
    console.log(
      `[qqbot-stream] created context: to=${to}, chunkSize=${this.chunkSize}, interval=${this.sendInterval}ms`
    );
  }

  /**
   * 初始化：获取 access token
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    if (!this.account.appId || !this.account.clientSecret) {
      throw new Error("QQBot not configured (missing appId or clientSecret)");
    }

    try {
      this.accessToken = await getAccessToken(
        this.account.appId,
        this.account.clientSecret
      );
      this.initialized = true;
      console.log(`[qqbot-stream] initialized, access token obtained`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[qqbot-stream] initialization failed: ${msg}`);
      throw err;
    }
  }

  /**
   * 缓冲一个 token chunk
   */
  async bufferChunk(chunk: string): Promise<void> {
    this.buffer += chunk;
    this.totalTokens++;
    
    // 每 10 个 token 或 50 字符打一次日志
    if (this.totalTokens % 10 === 0) {
      console.log(
        `[qqbot-stream] buffered: total tokens=${this.totalTokens}, buffer=${this.buffer.length} chars`
      );
    }

    // 缓冲满了就刷新
    if (this.buffer.length >= this.chunkSize) {
      await this.flushBuffer();
    }
  }

  /**
   * 刷新缓冲：发送当前缓冲内容到 QQ
   */
  async flushBuffer(): Promise<void> {
    if (!this.buffer) {
      console.log(`[qqbot-stream] flushBuffer: buffer is empty, skipping`);
      return;
    }

    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.accessToken) {
      throw new Error("Access token not available");
    }

    const target = parseTarget(this.to);
    const chunkIndex = this.sentChunks.length;
    const content = this.buffer;

    try {
      if (target.type === "c2c") {
        const result = await sendProactiveC2CMessage(
          this.accessToken,
          target.id,
          content,
          {
            state: 1, // 生成中
            id: this.streamId,
            index: chunkIndex,
            reset: false,
          }
        );

        this.streamId = result.id;
        this.messageId = result.id;
        this.sentChunks.push(content);
        
        console.log(
          `[qqbot-stream] flushed C2C chunk ${chunkIndex + 1}: ${content.length} chars, id=${this.streamId}`
        );

      } else if (target.type === "group") {
        const result = await sendProactiveGroupMessage(
          this.accessToken,
          target.id,
          content,
          {
            state: 1,
            id: this.streamId,
            index: chunkIndex,
            reset: false,
          }
        );

        this.streamId = result.id;
        this.messageId = result.id;
        this.sentChunks.push(content);
        
        console.log(
          `[qqbot-stream] flushed group chunk ${chunkIndex + 1}: ${content.length} chars, id=${this.streamId}`
        );

      } else {
        // 频道暂不支持流式
        console.warn(`[qqbot-stream] channel does not support streaming, skipping`);
        this.sentChunks.push(content);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[qqbot-stream] flush error: ${msg}`);
      throw err;
    }

    // 清空缓冲
    this.buffer = "";

    // 等待间隔（避免 QQ API 限流）
    await sleep(this.sendInterval);
  }

  /**
   * 完成流式发送：发送终结消息
   */
  async finalize(): Promise<void> {
    if (this.finalized) {
      console.log(`[qqbot-stream] already finalized, skipping`);
      return;
    }

    // 先刷新剩余的缓冲
    if (this.buffer.length > 0) {
      await this.flushBuffer();
    }

    if (!this.sentChunks.length) {
      console.warn(`[qqbot-stream] no chunks sent, cannot finalize`);
      return;
    }

    if (!this.initialized) {
      await this.initialize();
    }

    if (!this.accessToken) {
      throw new Error("Access token not available");
    }

    // 获取完整文本（所有分片的拼接）
    const fullText = this.sentChunks.join("");
    const target = parseTarget(this.to);

    try {
      if (target.type === "c2c") {
        await sendProactiveC2CMessage(
          this.accessToken,
          target.id,
          fullText,
          {
            state: 10, // 完成
            id: this.streamId,
            index: 1,
            reset: true, // 用完整文本替换
          }
        );
        
        console.log(
          `[qqbot-stream] C2C finalized: ${this.sentChunks.length} chunks, total ${fullText.length} chars`
        );

      } else if (target.type === "group") {
        await sendProactiveGroupMessage(
          this.accessToken,
          target.id,
          fullText,
          {
            state: 10,
            id: this.streamId,
            index: 1,
            reset: true,
          }
        );
        
        console.log(
          `[qqbot-stream] group finalized: ${this.sentChunks.length} chunks, total ${fullText.length} chars`
        );

      } else {
        console.warn(`[qqbot-stream] channel finalization not supported`);
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[qqbot-stream] finalize error: ${msg}`);
      throw err;
    }

    this.finalized = true;
  }

  /**
   * 获取当前缓冲长度
   */
  getBufferLength(): number {
    return this.buffer.length;
  }

  /**
   * 获取消息 ID
   */
  getMessageId(): string | undefined {
    return this.messageId;
  }

  /**
   * 获取已发送的分片数
   */
  getChunkCount(): number {
    return this.sentChunks.length;
  }

  /**
   * 获取总的 token 数
   */
  getTotalTokens(): number {
    return this.totalTokens;
  }

  /**
   * 设置缓冲大小
   */
  setChunkSize(size: number): void {
    this.chunkSize = size;
  }

  /**
   * 设置发送间隔
   */
  setSendInterval(interval: number): void {
    this.sendInterval = interval;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalTokens: number;
    chunksSent: number;
    totalChars: number;
    buffer: number;
    finalized: boolean;
  } {
    return {
      totalTokens: this.totalTokens,
      chunksSent: this.sentChunks.length,
      totalChars: this.sentChunks.reduce((sum, c) => sum + c.length, 0) + this.buffer.length,
      buffer: this.buffer.length,
      finalized: this.finalized,
    };
  }
}
