/**
 * 出站消息合并回复（Deliver Debounce）模块
 *
 * 解决的问题：
 * 当 openclaw 框架层的 embedded agent 超时或快速连续产生多次 deliver 时，
 * 用户会在短时间内收到大量碎片消息（消息轰炸）。
 *
 * 解决方案：
 * 在 deliver 回调和实际发送之间加入 debounce 层。
 * 短时间内（windowMs）连续到达的多条纯文本 deliver 会被合并为一条消息发送。
 * 含媒体的 deliver 会立即 flush 已缓冲的文本并正常处理媒体。
 */

import type { DeliverDebounceConfig } from "./types.js";

// ============ 默认值 ============

const DEFAULT_WINDOW_MS = 1500;
const DEFAULT_MAX_WAIT_MS = 8000;
const DEFAULT_SEPARATOR = "\n\n---\n\n";

// ============ 类型定义 ============

export interface DeliverPayload {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
}

export interface DeliverInfo {
  kind: string;
}

/** 实际执行发送的回调 */
export type DeliverExecutor = (payload: DeliverPayload, info: DeliverInfo) => Promise<void>;

// ============ DeliverDebouncer 类 ============

export class DeliverDebouncer {
  private readonly windowMs: number;
  private readonly maxWaitMs: number;
  private readonly separator: string;
  private readonly executor: DeliverExecutor;
  private readonly log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
  private readonly prefix: string;

  /** 缓冲中的文本片段 */
  private bufferedTexts: string[] = [];
  /** 缓冲中最后一次 deliver 的 info（用于 flush 时传递 kind） */
  private lastInfo: DeliverInfo | null = null;
  /** 缓冲中最后一次 deliver 的 payload（非文本字段，如 mediaUrls） */
  private lastPayload: DeliverPayload | null = null;
  /** debounce 定时器 */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 最大等待定时器（从第一条 deliver 开始计算） */
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  /** 是否正在 flush */
  private flushing = false;
  /** 已销毁标记 */
  private disposed = false;

  constructor(
    config: DeliverDebounceConfig | undefined,
    executor: DeliverExecutor,
    log?: { info: (msg: string) => void; error: (msg: string) => void },
    prefix = "[debounce]",
  ) {
    this.windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxWaitMs = config?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.separator = config?.separator ?? DEFAULT_SEPARATOR;
    this.executor = executor;
    this.log = log;
    this.prefix = prefix;
  }

  /**
   * 接收一次 deliver 调用。
   * - 纯文本 deliver → 缓冲并设置 debounce 定时器
   * - 含媒体 deliver → 先 flush 已缓冲文本，再直接执行当前 deliver
   */
  async deliver(payload: DeliverPayload, info: DeliverInfo): Promise<void> {
    if (this.disposed) return;

    const hasMedia = Boolean(
      (payload.mediaUrls && payload.mediaUrls.length > 0) || payload.mediaUrl,
    );
    const text = (payload.text ?? "").trim();

    // 含媒体的 deliver：立即 flush 缓冲 + 直接执行
    if (hasMedia) {
      this.log?.info(`${this.prefix} Media deliver detected, flushing ${this.bufferedTexts.length} buffered text(s) first`);
      await this.flush();
      await this.executor(payload, info);
      return;
    }

    // 空文本 deliver：直接透传（不缓冲）
    if (!text) {
      await this.executor(payload, info);
      return;
    }

    // 纯文本 deliver：缓冲
    this.bufferedTexts.push(text);
    this.lastInfo = info;
    this.lastPayload = payload;

    this.log?.info(
      `${this.prefix} Buffered text #${this.bufferedTexts.length} (${text.length} chars), window=${this.windowMs}ms`,
    );

    // 重置 debounce 定时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.flush().catch((err) => {
        this.log?.error(`${this.prefix} Flush error (debounce timer): ${err}`);
      });
    }, this.windowMs);

    // 首次缓冲时启动最大等待定时器
    if (this.bufferedTexts.length === 1) {
      if (this.maxWaitTimer) {
        clearTimeout(this.maxWaitTimer);
      }
      this.maxWaitTimer = setTimeout(() => {
        this.log?.info(`${this.prefix} Max wait (${this.maxWaitMs}ms) reached, force flushing`);
        this.flush().catch((err) => {
          this.log?.error(`${this.prefix} Flush error (max wait timer): ${err}`);
        });
      }, this.maxWaitMs);
    }
  }

  /**
   * 将缓冲中的文本合并为一条消息发送
   */
  async flush(): Promise<void> {
    if (this.flushing || this.bufferedTexts.length === 0) return;
    this.flushing = true;

    // 清除定时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }

    // 取出缓冲
    const texts = this.bufferedTexts;
    const info = this.lastInfo!;
    const lastPayload = this.lastPayload!;
    this.bufferedTexts = [];
    this.lastInfo = null;
    this.lastPayload = null;

    try {
      if (texts.length === 1) {
        // 只有一条，直接透传原始 payload
        this.log?.info(`${this.prefix} Flushing single buffered text (${texts[0].length} chars)`);
        await this.executor({ ...lastPayload, text: texts[0] }, info);
      } else {
        // 多条合并
        const merged = texts.join(this.separator);
        this.log?.info(
          `${this.prefix} Merged ${texts.length} buffered texts into one (${merged.length} chars)`,
        );
        await this.executor({ ...lastPayload, text: merged }, info);
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 销毁：flush 剩余缓冲并清除定时器
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
    // flush 剩余
    if (this.bufferedTexts.length > 0) {
      this.flushing = false; // 确保 flush 能执行
      await this.flush();
    }
  }

  /** 当前是否有缓冲中的文本 */
  get hasPending(): boolean {
    return this.bufferedTexts.length > 0;
  }

  /** 缓冲中的文本数量 */
  get pendingCount(): number {
    return this.bufferedTexts.length;
  }
}

// ============ 工厂函数 ============

/**
 * 根据配置创建 debouncer 或返回 null（禁用时）
 */
export function createDeliverDebouncer(
  config: DeliverDebounceConfig | undefined,
  executor: DeliverExecutor,
  log?: { info: (msg: string) => void; error: (msg: string) => void },
  prefix?: string,
): DeliverDebouncer | null {
  // 未配置时默认启用
  if (config?.enabled === false) {
    return null;
  }
  return new DeliverDebouncer(config, executor, log, prefix);
}
