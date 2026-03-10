# QQ Bot 流式发送指南

## 功能概述

我为 QQ Bot 插件添加了 **流式发送支持**，允许将长文本分成多个块逐个发送，模拟"正在输入..."的效果。

## 核心改动

### 1. API 层 (`src/api.ts`)

#### 新增接口
```typescript
interface StreamOptions {
  state?: number;      // 1=生成中, 10=结束
  id?: string;         // 流式消息ID（用于续接）
  index?: number;      // 分片序号
  reset?: boolean;     // 是否重置整条消息
}
```

#### 修改的函数
- `sendProactiveC2CMessage(accessToken, openid, content, stream?)` 
  - 新增 `stream` 参数，支持流式模式
- `sendProactiveGroupMessage(accessToken, groupOpenid, content, stream?)`
  - 新增 `stream` 参数，支持流式模式

#### 新增函数
- `sendProactiveC2CMessageStream(accessToken, openid, fullContent, chunks, interval)`
  - 自动处理流式发送的完整逻辑
  - 分阶段发送每个分片
  - 最后用 `reset=true` 替换为完整文本

- `sendProactiveGroupMessageStream(accessToken, groupOpenid, fullContent, chunks, interval)`
  - 群聊版本的流式发送

### 2. 业务层 (`src/outbound.ts`)

#### 新增类型
```typescript
interface OutboundContext {
  // ... 现有字段 ...
  stream?: {
    enabled?: boolean;      // 是否启用流式发送
    maxChunkChars?: number; // 每个分片的最大字符数（默认 100）
    interval?: number;      // 分片间隔（毫秒，默认 100）
  };
}
```

#### 新增函数
- `splitByLines(text, maxChars)` 
  - 按行累积切分文本
  - 保证每个分片都以 `\n` 结尾
  - 避免在句子中间断裂

#### 修改的函数
- `sendProactiveMessage(account, to, text, stream?)`
  - 新增 `stream` 参数
  - 当 `stream.enabled=true` 时自动使用流式模式
  - 遇到错误自动降级为普通发送

## 使用方法

### 方法 1：通过 OpenClaw 的 message 工具

```javascript
// 示例（未来支持，目前需要直接调用 API）
message send "用户ID" "长文本内容" --stream --maxChunkChars 50 --interval 100
```

### 方法 2：直接调用 Python 脚本

你提供的 Python 脚本完全兼容！直接运行：

```bash
python stream_test.py
```

脚本会：
1. 按行切分文本（每 50 字一块）
2. 循环发送 state=1 的块
3. 最后发送 state=10 的完整替换

### 方法 3：从 OpenClaw 会话中调用（未来）

```typescript
// 在 OpenClaw agent 中
await send({
  to: "qqbot:c2c:OPENID",
  text: longText,
  stream: {
    enabled: true,
    maxChunkChars: 50,
    interval: 100,
  }
});
```

## 技术细节

### 流式发送流程

```
1. 收到长文本 → 按行切分成 N 个块
   
2. 循环发送块 (i=0 to N-1)
   ├─ POST /v2/users/{OPENID}/messages
   ├─ body.stream = { state: 1, id: streamId, index: i, reset: false }
   ├─ 获取返回的 streamId（用于下一块的续接）
   └─ 等待 interval ms
   
3. 发送终结消息
   ├─ POST /v2/users/{OPENID}/messages
   ├─ body.stream = { state: 10, id: streamId, index: 1, reset: true }
   ├─ body.markdown.content = 全量文本（完整替换）
   └─ 完成
```

### 关键参数说明

| 参数 | 含义 | 取值 | 说明 |
|------|------|------|------|
| `state` | 消息状态 | 1 \| 10 | 1=生成中，10=结束 |
| `id` | 流式消息ID | string \| null | 首条为 null，后续为上一条返回的 id |
| `index` | 分片序号 | 0-N | 从 0 开始递增 |
| `reset` | 是否重置 | boolean | true 时用全量文本替换 |

### 错误处理

如果流式发送失败（如网络错误），自动降级为普通发送：

```
流式发送失败 → 日志输出警告 → 自动发送完整内容（一次性）
```

## 性能建议

- **短消息**（< 500 字）：不需要流式，普通发送更快
- **中等文本**（500-5000 字）：
  - `maxChunkChars: 100-200`
  - `interval: 50-100ms`
- **长文本**（> 5000 字）：
  - `maxChunkChars: 50-100`
  - `interval: 200-500ms`（避免 QQ API 限流）

## 限制

1. **仅支持 C2C 和群聊**
   - 频道暂不支持（自动降级为普通发送）

2. **Markdown 格式**
   - 需要机器人已启用 Markdown 权限
   - 分片过程中 Markdown 语法可能被打破（最后修复）

3. **QQ API 限制**
   - 每个用户/群每月仅 4 条主动消息
   - 流式计为多条消息，配额消耗快
   - **建议仅在回复用户消息（被动回复）时使用流式**

## 已知问题

1. 分片中间可能出现 Markdown 格式错乱（最后的 reset 会修复）
2. 分片太快可能被 QQ API 限流（调整 interval）
3. 网络不稳定时某些分片可能丢失（无重试机制）

## 测试

编译已完成，代码中的错误仅来自原始代码（channel.ts）。

流式函数已正确编译到 `dist/src/api.js` 和 `dist/src/outbound.js`。

## 下一步

1. ✅ 实现流式 API 层（已完成）
2. ✅ 实现业务层支持（已完成）
3. ⏳ 在 OpenClaw channel 集成中调用流式函数
4. ⏳ 添加 UI 配置选项

---

**备份文件**: `api.ts.bak` （修改前的原始版本）

**问题反馈**: 欢迎在 GitHub 提 Issue 或 PR！
