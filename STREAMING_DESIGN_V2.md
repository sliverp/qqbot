# QQ Bot 真正流式发送设计方案 (v2)

## 核心理念

不是手动分割文本，而是**拦截 OpenClaw 的流式响应**，在大模型一边生成一边把流式 token 发送到 QQ。

## 架构设计

```
┌─────────────────────────┐
│  OpenClaw Agent         │
│  (流式请求大模型)         │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│  大模型流式响应                      │
│  chunk1: "你"                       │
│  chunk2: "好"                       │
│  chunk3: "，我是AI"                 │
│  ...                                │
└────────────┬────────────────────────┘
             │
             ▼ (OpenClaw 框架)
┌──────────────────────────────────────────────┐
│  Channel 流式 deliver 拦截                   │
│  ─────────────────────────────────────────   │
│  1. 收到 chunk1 → 缓冲（累积 N 个 token）    │
│  2. 收到 chunk2 → 继续缓冲                    │
│  3. 缓冲满了 → 发送到 QQ (state=1, id=xxx)  │
│  4. 继续接收并发送                           │
│  5. 流式完成 → 发送终结消息 (state=10)       │
└────────────┬─────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────┐
│  QQ Bot API                          │
│  (带 stream 字段)                    │
└────────────┬──────────────────────────┘
             │
             ▼
┌──────────────────────────────────────┐
│  QQ 客户端                           │
│  看到"正在输入..."逐步显示 ✨         │
└──────────────────────────────────────┘
```

## 实现步骤

### 1. 修改 channel.ts

```typescript
export const qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  // ... 其他配置 ...
  
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    blockStreaming: true,  // ✨ 改为 true，启用块流式
  },

  outbound: {
    deliveryMode: "stream",  // ✨ 改为 "stream"
    chunker: undefined,      // 不需要预先分割
    
    // ✨ 新增：流式传输处理
    deliverStream: async (ctx) => {
      const { to, accountId, replyToId, cfg } = ctx;
      const account = resolveQQBotAccount(cfg, accountId);
      
      if (!account.appId || !account.clientSecret) {
        return { error: new Error("QQBot not configured") };
      }

      // 创建流式发送上下文
      const streamCtx = new QQBotStreamContext(
        account,
        to,
        replyToId
      );

      // ✨ 设置流式处理
      ctx.onChunk = async (chunk: string) => {
        await streamCtx.bufferChunk(chunk);
        // 每缓冲 50 个字符发一次
        if (streamCtx.getBufferLength() >= 50) {
          await streamCtx.flushBuffer();
        }
      };

      ctx.onComplete = async () => {
        // 发送剩余的缓冲
        await streamCtx.flushBuffer();
        // 发送终结消息
        await streamCtx.finalize();
        return { messageId: streamCtx.getMessageId() };
      };

      ctx.onError = async (error) => {
        // 降级为普通发送（发送已缓冲内容）
        await streamCtx.flushBuffer();
        await streamCtx.finalize();
        return { error };
      };

      return {};
    },

    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      // 普通（非流式）发送
      const account = resolveQQBotAccount(cfg, accountId);
      const result = await sendText({ to, text, accountId, replyToId, account });
      return {
        channel: "qqbot",
        messageId: result.messageId,
        error: result.error ? new Error(result.error) : undefined,
      };
    },
  },
};
```

### 2. 新增 stream-context.ts

处理流式发送的状态管理：

```typescript
import { getAccessToken, sendProactiveC2CMessageStream, sendProactiveGroupMessageStream } from "./api.js";
import type { ResolvedQQBotAccount } from "./types.js";

export class QQBotStreamContext {
  private account: ResolvedQQBotAccount;
  private to: string;
  private replyToId?: string | null;
  
  private buffer: string = "";
  private chunks: string[] = [];
  private streamId: string | undefined;
  private messageId: string | undefined;
  private accessToken: string | undefined;
  
  private chunkSize: number = 50; // 字符数，可配置
  private sendInterval: number = 100; // 毫秒

  constructor(account: ResolvedQQBotAccount, to: string, replyToId?: string | null) {
    this.account = account;
    this.to = to;
    this.replyToId = replyToId;
  }

  async initialize() {
    this.accessToken = await getAccessToken(
      this.account.appId!,
      this.account.clientSecret!
    );
  }

  async bufferChunk(chunk: string) {
    this.buffer += chunk;
    console.log(`[qqbot-stream] buffered: ${chunk.length} chars, total: ${this.buffer.length}`);
  }

  async flushBuffer() {
    if (!this.buffer) return;
    if (!this.accessToken) await this.initialize();

    const target = parseTarget(this.to);
    
    // 格式化缓冲内容为 Markdown（如果需要）
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
            index: this.chunks.length,
            reset: false,
          }
        );
        
        this.streamId = result.id;
        this.messageId = result.id;
        this.chunks.push(content);
        console.log(`[qqbot-stream] flushed chunk ${this.chunks.length}, id=${this.streamId}`);
        
      } else if (target.type === "group") {
        const result = await sendProactiveGroupMessage(
          this.accessToken,
          target.id,
          content,
          {
            state: 1,
            id: this.streamId,
            index: this.chunks.length,
            reset: false,
          }
        );
        
        this.streamId = result.id;
        this.messageId = result.id;
        this.chunks.push(content);
        console.log(`[qqbot-stream] flushed chunk ${this.chunks.length}, id=${this.streamId}`);
      }
    } catch (err) {
      console.error(`[qqbot-stream] flush error: ${err}`);
      throw err;
    }

    // 清空缓冲
    this.buffer = "";
    
    // 等待间隔
    await sleep(this.sendInterval);
  }

  async finalize() {
    if (!this.chunks.length) return;
    if (!this.accessToken) await this.initialize();

    // 获取完整文本
    const fullText = this.chunks.join("");
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
            reset: true,
          }
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
      }
      
      console.log(`[qqbot-stream] finalized with ${this.chunks.length} chunks`);
    } catch (err) {
      console.error(`[qqbot-stream] finalize error: ${err}`);
      throw err;
    }
  }

  getBufferLength(): number {
    return this.buffer.length;
  }

  getMessageId(): string | undefined {
    return this.messageId;
  }

  setChunkSize(size: number) {
    this.chunkSize = size;
  }

  setSendInterval(interval: number) {
    this.sendInterval = interval;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseTarget(to: string): { type: "c2c" | "group"; id: string } {
  // 复用 outbound.ts 中的 parseTarget 逻辑
  // ...
}
```

### 3. 改进 api.ts

确保现有的非流式函数不受影响，仅修改支持可选的 stream 参数：

```typescript
// 这部分你已经做过了，保持不变
export async function sendProactiveC2CMessage(
  accessToken: string,
  openid: string,
  content: string,
  stream?: StreamOptions
): Promise<{ id: string; timestamp: number }> {
  const body = buildProactiveMessageBody(content, stream);
  // ...
}
```

## 工作流程对比

### 旧方案（我之前实现的）
```
长文本 → [主动分割] → 逐个发送预定义的块 → 完成
```
缺点：
- 文本已经生成完了才开始分割
- 不能利用大模型的流式能力
- 用户等待时间长

### 新方案（正确的）
```
用户问题 → [发送给大模型] → 流式接收 token
                               ↓
                        [缓冲 N 个 token]
                               ↓
                        [缓冲满了就发一条]
                               ↓
                        用户看到逐步生成✨
```

优点：
- ✅ 充分利用大模型流式能力
- ✅ 用户实时看到生成过程
- ✅ 更好的交互体验

## 关键配置参数

在 `QQBotStreamContext` 中可配置：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `chunkSize` | 50 | 缓冲多少字符才发一次（防止过频繁） |
| `sendInterval` | 100ms | 每次发送之间的等待时间 |
| `enableMarkdown` | true | 是否保留 Markdown 格式 |

## 集成步骤

1. ✅ 修改 `channel.ts`：启用 `blockStreaming` + 实现 `deliverStream`
2. ✅ 创建 `stream-context.ts`：流式状态管理
3. ✅ 保持现有 `api.ts` 兼容
4. ✅ 编译验证
5. 🧪 实际测试

## 与之前实现的关系

之前的 `splitByLines` 和 `sendProactiveC2CMessageStream` 不需要删除，只是用法改变：

- **之前**：主动调用，用于手动分割发送
- **现在**：由 `QQBotStreamContext` 内部调用，自动化处理

## 预期效果

用户输入问题后：
1. 第一个 token 出现：用户立即看到"正在输入..."
2. 接下来的 token 逐步显示
3. 整个过程流畅自然，像真人打字

---

**下一步**：实现 stream-context.ts 并集成到 channel.ts
