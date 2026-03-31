/**
 * StreamingController 集成测试
 *
 * 通过 mock global.fetch 验证流式消息控制器的核心行为，
 * 重点覆盖：循环消费模型 (processMediaTags) + pendingNormalizedFull 补救机制。
 *
 * 运行方式:  npx tsx tests/streaming-controller.test.ts
 */

import assert from "node:assert";

// ============ Mock global.fetch ============

/** 记录所有流式 API 调用 */
interface StreamCall {
  content: string;
  inputState: number; // 1 = GENERATING, 10 = DONE
  streamMsgId?: string;
  index: number;
  url: string;
}

/** 记录所有媒体上传 API 调用 */
interface MediaUploadCall {
  url: string;
  body: any;
}

let streamCalls: StreamCall[] = [];
let mediaUploadCalls: MediaUploadCall[] = [];
let streamMsgIdCounter = 0;

/** 控制流式 API 的延迟（毫秒）。设为 > 0 模拟 API 慢响应。 */
let apiDelayMs = 0;

/** 控制媒体上传 API 的延迟（毫秒）。 */
let mediaApiDelayMs = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function resetMocks() {
  streamCalls = [];
  mediaUploadCalls = [];
  streamMsgIdCounter = 0;
  apiDelayMs = 0;
  mediaApiDelayMs = 0;
}

// 保存原始 fetch
const originalFetch = globalThis.fetch;

// 覆写 global.fetch
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const body = init?.body ? JSON.parse(init.body as string) : {};

  // ---- Token 请求 ----
  if (url.includes("/getAppAccessToken")) {
    return new Response(JSON.stringify({
      access_token: "mock-token-12345",
      expires_in: "7200",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // ---- 流式消息 API ----
  if (url.includes("/stream_messages")) {
    if (apiDelayMs > 0) await sleep(apiDelayMs);

    const call: StreamCall = {
      content: body.content_raw ?? "",
      inputState: body.input_state ?? 0,
      streamMsgId: body.stream_msg_id,
      index: body.index ?? 0,
      url,
    };
    streamCalls.push(call);

    // 首次调用（无 stream_msg_id）→ 返回新的 stream_msg_id
    let respBody: any;
    if (!body.stream_msg_id) {
      streamMsgIdCounter++;
      respBody = { id: `stream-${streamMsgIdCounter}`, timestamp: Date.now().toString() };
    } else {
      respBody = { id: body.stream_msg_id, timestamp: Date.now().toString() };
    }

    return new Response(JSON.stringify(respBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ---- 富媒体上传 API (v2/users/.../files) ----
  if (url.includes("/files")) {
    if (mediaApiDelayMs > 0) await sleep(mediaApiDelayMs);

    mediaUploadCalls.push({ url, body });

    return new Response(JSON.stringify({
      file_uuid: `uuid-${mediaUploadCalls.length}`,
      file_info: "mock",
      ttl: 3600,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ---- 普通消息 API (v2/users/.../messages) ----
  if (url.includes("/messages")) {
    if (mediaApiDelayMs > 0) await sleep(mediaApiDelayMs);

    return new Response(JSON.stringify({
      id: `msg-resp-${Date.now()}`,
      timestamp: Date.now().toString(),
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 未匹配的请求，回退到原始 fetch
  console.warn(`[mock-fetch] 未匹配的请求: ${url}`);
  return originalFetch(input, init);
};

// ---- 现在 import StreamingController（它会使用被 mock 的 global.fetch） ----
const { StreamingController } = await import("../src/streaming.js");
type StreamingControllerType = InstanceType<typeof StreamingController>;

// ============ 辅助函数 ============

/** 等待异步任务完成 */
async function flush(ms = 100): Promise<void> {
  await sleep(ms);
}

/** 收集日志 */
const logs: string[] = [];

function createController(opts?: { mediaContext?: boolean }): StreamingControllerType {
  logs.length = 0;
  const deps: any = {
    account: {
      accountId: "test",
      enabled: true,
      appId: "test-app",
      clientSecret: "test-secret",
      secretSource: "config" as const,
      markdownSupport: true,
      config: {
        streaming: true,
        streamingConfig: { throttleMs: 50 }, // 短节流方便测试
      },
    },
    userId: "user-1",
    replyToMsgId: "msg-1",
    eventId: "event-1",
    logPrefix: "[test]",
    log: {
      info: (m: string) => logs.push(`[INFO] ${m}`),
      error: (m: string) => logs.push(`[ERROR] ${m}`),
      warn: (m: string) => logs.push(`[WARN] ${m}`),
      debug: (m: string) => logs.push(`[DEBUG] ${m}`),
    },
  };
  if (opts?.mediaContext) {
    deps.mediaContext = {
      account: deps.account,
      event: { type: "c2c", senderId: "user-1", messageId: "msg-1" },
      log: deps.log,
    };
  }
  return new StreamingController(deps);
}

// ============ 测试框架 ============

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  resetMocks();
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    if (e.stack) {
      const lines = (e.stack as string).split("\n").slice(1, 4);
      for (const l of lines) console.log(`     ${l.trim()}`);
    }
    // 打印关键日志（去掉 DEBUG 减少噪音）
    const relevantLogs = logs.filter((l) => !l.includes("[DEBUG]")).slice(-10);
    if (relevantLogs.length > 0) {
      console.log(`     --- 日志 ---`);
      for (const l of relevantLogs) console.log(`       ${l}`);
    }
    failed++;
    failedTests.push(name);
  }
}

// ============ 测试用例 ============

console.log("\n=== 1. 纯文本流式 ===");

await test("纯文本: 基本流式 → 完成", async () => {
  const ctrl = createController();

  await ctrl.onPartialReply({ text: "你好" });
  await flush();
  await ctrl.onPartialReply({ text: "你好世界" });
  await flush();

  ctrl.markFullyComplete();
  await ctrl.onIdle();

  // 应该有流式分片发送
  assert.ok(streamCalls.length >= 2, `应至少有 2 次流式调用，实际 ${streamCalls.length}`);
  // 最后一次应该是 DONE (inputState=10)
  const last = streamCalls[streamCalls.length - 1];
  assert.strictEqual(last.inputState, 10, "最后一次应为 DONE");
  assert.ok(last.content.includes("你好世界"), `最终文本应包含完整内容，实际: "${last.content}"`);
  // 不应有媒体上传
  assert.strictEqual(mediaUploadCalls.length, 0, "不应有媒体上传");
});

await test("纯文本: 空文本被忽略", async () => {
  const ctrl = createController();

  await ctrl.onPartialReply({ text: "" });
  await ctrl.onPartialReply({ text: undefined });
  await flush();

  assert.strictEqual(streamCalls.length, 0, "不应有流式调用");
});

await test("纯文本: 全空白不启动流式，后续非空白一起发送", async () => {
  const ctrl = createController();

  // 先来一段全空白内容 — 不应启动流式
  await ctrl.onPartialReply({ text: "\n\n  " });
  await flush();
  assert.strictEqual(streamCalls.length, 0, "全空白阶段不应有流式调用");

  // 后续有非空白内容到达 — 应启动流式，且包含之前的空白
  await ctrl.onPartialReply({ text: "\n\n  hello world" });
  await flush(200);

  assert.ok(streamCalls.length >= 1, `应有至少 1 次流式调用，实际 ${streamCalls.length}`);
  // 首次发送的内容应包含之前保留的空白 + 新内容
  const firstContent = streamCalls[0].content;
  assert.ok(firstContent.includes("hello world"), `首次发送应包含 "hello world"，实际: "${firstContent}"`);

  ctrl.markFullyComplete();
  await ctrl.onIdle();
  await flush(100);
});

await test("纯文本: 全空白 + 媒体标签，空白不发送，媒体正常处理", async () => {
  const ctrl = createController({ mediaContext: true });

  apiDelayMs = 5;
  mediaApiDelayMs = 5;

  // 全空白前缀 + 媒体标签一起到达
  await ctrl.onPartialReply({ text: "\n\n<qqimg>/tmp/pic.jpg</qqimg>描述文字" });
  await flush(400);

  ctrl.markFullyComplete();
  await ctrl.onIdle();
  await flush(200);

  // 验证：日志中检测到了媒体标签
  const foundLogs = logs.filter((l) => l.includes("processMediaTags: found"));
  assert.ok(foundLogs.length >= 1, `应检测到 qqimg 标签，实际 ${foundLogs.length} 条`);

  // 验证：不应有 PREFIX MISMATCH 错误
  const prefixMismatchLogs = logs.filter((l) => l.includes("PREFIX MISMATCH"));
  assert.strictEqual(prefixMismatchLogs.length, 0, `不应有 PREFIX MISMATCH，实际: ${prefixMismatchLogs.join("; ")}`);

  // 验证：如果有流式分片发送，内容不应是纯空白
  const generatingCalls = streamCalls.filter((c) => c.inputState === 1);
  for (const call of generatingCalls) {
    assert.ok(call.content.trim().length > 0, `流式分片不应为纯空白: "${call.content}"`);
  }
});

await test("纯文本: 空白→媒体→空白→媒体→空白，只有媒体发出，空白全忽略", async () => {
  const ctrl = createController({ mediaContext: true });

  apiDelayMs = 5;
  mediaApiDelayMs = 5;

  // 逐步送入：空白 → 媒体标签1 → 空白 → 媒体标签2 → 空白
  const fullText =
    "\n  \n" +
    "<qqimg>/tmp/pic1.jpg</qqimg>" +
    "\n\n  \n" +
    "<qqimg>/tmp/pic2.jpg</qqimg>" +
    "  \n\n";

  // 模拟流式分段到达
  // 阶段 1：纯空白
  await ctrl.onPartialReply({ text: "\n  \n" });
  await flush(200);
  assert.strictEqual(streamCalls.length, 0, "纯空白阶段不应有流式调用");

  // 阶段 2：空白 + 第一个媒体标签
  await ctrl.onPartialReply({ text: "\n  \n<qqimg>/tmp/pic1.jpg</qqimg>" });
  await flush(400);

  // 阶段 3：继续加空白
  await ctrl.onPartialReply({
    text: "\n  \n<qqimg>/tmp/pic1.jpg</qqimg>\n\n  \n",
  });
  await flush(200);

  // 阶段 4：第二个媒体标签
  await ctrl.onPartialReply({
    text: "\n  \n<qqimg>/tmp/pic1.jpg</qqimg>\n\n  \n<qqimg>/tmp/pic2.jpg</qqimg>",
  });
  await flush(400);

  // 阶段 5：末尾空白，完成
  await ctrl.onPartialReply({ text: fullText });
  await flush(200);

  ctrl.markFullyComplete();
  await ctrl.onIdle();
  await flush(300);

  // 验证 1：应检测到 2 个媒体标签
  const foundLogs = logs.filter((l) => l.includes("processMediaTags: found"));
  assert.ok(foundLogs.length >= 2, `应检测到至少 2 个 qqimg 标签，实际 ${foundLogs.length} 条`);

  // 验证 2：应有 2 次媒体发送尝试（sendPhoto 可能因文件不存在失败，但 sending 日志应存在）
  const sendingLogs = logs.filter((l) => l.includes("sending image"));
  assert.ok(sendingLogs.length >= 2, `应有至少 2 次发送图片尝试，实际 ${sendingLogs.length} 次`);

  // 验证 3：不应有 PREFIX MISMATCH 错误
  const prefixMismatchLogs = logs.filter((l) => l.includes("PREFIX MISMATCH"));
  assert.strictEqual(
    prefixMismatchLogs.length,
    0,
    `不应有 PREFIX MISMATCH，实际: ${prefixMismatchLogs.join("; ")}`,
  );

  // 验证 4：流式分片（GENERATING 状态）中不应出现纯空白内容
  const generatingCallsInner = streamCalls.filter((c) => c.inputState === 1);
  for (const call of generatingCallsInner) {
    assert.ok(
      call.content.trim().length > 0,
      `流式分片不应为纯空白: "${call.content.replace(/\n/g, "\\n").replace(/ /g, "·")}"`,
    );
  }

  // 验证 5：如果有流式启动（首次调用，无 stream_msg_id），首次内容也不应纯空白
  const startCalls = streamCalls.filter((c) => !c.streamMsgId);
  for (const call of startCalls) {
    assert.ok(
      call.content.trim().length > 0,
      `流式启动内容不应为纯空白: "${call.content.replace(/\n/g, "\\n").replace(/ /g, "·")}"`,
    );
  }
});

console.log("\n=== 2. 单个媒体标签 ===");

await test("媒体标签: 多媒体后跟文本，onIdle 终结不 PREFIX MISMATCH", async () => {
  const ctrl = createController({ mediaContext: true });

  apiDelayMs = 5;
  mediaApiDelayMs = 5;

  // 模拟实际场景：两个语音标签 + 后续文本描述，逐步到达
  // 阶段1：第一个语音标签
  await ctrl.onPartialReply({
    text: "<qqvoice>/tmp/voice1.mp3</qqvoice>",
  });
  await flush(400);

  // 阶段2：两个语音标签
  await ctrl.onPartialReply({
    text: "<qqvoice>/tmp/voice1.mp3</qqvoice>\n<qqvoice>/tmp/voice2.mp3</qqvoice>",
  });
  await flush(400);

  // 阶段3：两个语音标签 + 后续文本
  await ctrl.onPartialReply({
    text: "<qqvoice>/tmp/voice1.mp3</qqvoice>\n<qqvoice>/tmp/voice2.mp3</qqvoice>\n两条语音都发给你啦！",
  });
  await flush(400);

  // 完成
  ctrl.markFullyComplete();
  await ctrl.onIdle();
  await flush(300);

  // 验证：应检测到 2 个媒体标签
  const foundLogs = logs.filter((l) => l.includes("processMediaTags: found"));
  assert.ok(foundLogs.length >= 2, `应检测到至少 2 个标签，实际 ${foundLogs.length} 条`);

  // 核心验证：不应有 PREFIX MISMATCH
  const prefixMismatchLogs = logs.filter((l) => l.includes("PREFIX MISMATCH"));
  assert.strictEqual(
    prefixMismatchLogs.length,
    0,
    `不应有 PREFIX MISMATCH，实际: ${prefixMismatchLogs.join("; ")}`,
  );

  // 验证：最终流式文本（如果有）应包含后续描述文本
  const doneCalls = streamCalls.filter((c) => c.inputState === 10);
  if (doneCalls.length > 0) {
    const lastDone = doneCalls[doneCalls.length - 1];
    assert.ok(
      lastDone.content.includes("两条语音都发给你啦"),
      `终结分片应包含后续文本，实际: "${lastDone.content.slice(0, 80)}"`,
    );
    // 终结文本不应包含原始媒体标签
    assert.ok(
      !lastDone.content.includes("<qqvoice>"),
      `终结文本不应包含 <qqvoice> 标签，实际: "${lastDone.content.slice(0, 80)}"`,
    );
  }
});

await test("媒体标签: 文本 + 图片 + 后续文本", async () => {
  const ctrl = createController({ mediaContext: true });

  // 一次性送入完整的含图片标签文本
  await ctrl.onPartialReply({ text: "看图：<qqimg>/tmp/cat.jpg</qqimg>" });
  await flush(300);

  // 后续文本到达
  await ctrl.onPartialReply({ text: "看图：<qqimg>/tmp/cat.jpg</qqimg>\n\n好看吧？" });
  await flush(300);

  ctrl.markFullyComplete();
  await ctrl.onIdle();

  // 验证：应有媒体上传调用（图片需要先上传再发送）
  // 或者至少流式中出现过图片相关处理
  // 关键验证：最终流式文本不应包含原始 <qqimg> 标签
  const lastStream = streamCalls[streamCalls.length - 1];
  assert.ok(!lastStream.content.includes("<qqimg>"), "最终文本不应包含 <qqimg> 标签");
});

await test("媒体标签: 纯媒体开头(无前置文本)", async () => {
  const ctrl = createController({ mediaContext: true });

  await ctrl.onPartialReply({ text: "<qqvoice>/tmp/hello.mp3</qqvoice>" });
  await flush(300);

  ctrl.markFullyComplete();
  await ctrl.onIdle();
  await flush(200);

  // 验证：应该至少有流式会话创建或媒体处理的记录
  const infoLogs = logs.filter((l) => l.includes("processMediaTags") && l.includes("found"));
  assert.ok(infoLogs.length >= 1, `应检测到 qqvoice 标签。相关日志: ${infoLogs.join("; ") || "无"}`);
});

console.log("\n=== 3. 多个媒体标签（循环消费） ===");

await test("多媒体: 两个图片标签被逐个处理", async () => {
  const ctrl = createController({ mediaContext: true });

  const text = "图1：<qqimg>/tmp/a.jpg</qqimg>\n图2：<qqimg>/tmp/b.jpg</qqimg>\n完毕";

  await ctrl.onPartialReply({ text });
  await flush(600);

  ctrl.markFullyComplete();
  await ctrl.onIdle();
  await flush(200);

  // 验证：日志中应显示找到了两个标签
  const foundLogs = logs.filter((l) => l.includes("processMediaTags: found"));
  assert.ok(foundLogs.length >= 2, `应找到至少 2 个标签，实际 ${foundLogs.length} 条 found 日志`);
});

console.log("\n=== 4. 未闭合标签等待 ===");

await test("未闭合标签: 逐步到达后完整处理", async () => {
  const ctrl = createController({ mediaContext: true });

  // 不完整的标签
  await ctrl.onPartialReply({ text: "开始<qqimg>/tmp/pic" });
  await flush(200);

  // 验证：此时流式文本应该只包含 "开始"，不含标签部分
  const midCalls = [...streamCalls];
  for (const call of midCalls) {
    assert.ok(!call.content.includes("<qqimg>"), `中间态不应包含未闭合标签，内容: "${call.content}"`);
  }

  // 标签完整了
  await ctrl.onPartialReply({ text: "开始<qqimg>/tmp/pic.jpg</qqimg>\n看看" });
  await flush(300);

  ctrl.markFullyComplete();
  await ctrl.onIdle();
  await flush(200);

  // 验证：应检测到完整标签
  const foundLogs = logs.filter((l) => l.includes("processMediaTags: found"));
  assert.ok(foundLogs.length >= 1, `标签完整后应被检测到，found 日志: ${foundLogs.length}`);
});

console.log("\n=== 5. ★ pendingNormalizedFull 补救机制 ===");

await test("补救: 媒体处理期间最后一次 onPartialReply 不丢失", async () => {
  const ctrl = createController({ mediaContext: true });

  // 设置 API 有延迟，模拟 processMediaTags 执行耗时
  apiDelayMs = 50;
  mediaApiDelayMs = 80;

  // 第1次: 含媒体标签 → 进入 processMediaTags，mediaInterruptInProgress=true
  const p1 = ctrl.onPartialReply({ text: "hi<qqimg>/tmp/x.jpg</qqimg>" });

  // 等一小段确保 processMediaTags 已经开始
  await sleep(20);

  // 第2次: 这是"最后一次" onPartialReply —— 带有新的后续文本
  // 因为 mediaInterruptInProgress=true，会被保存到 pendingNormalizedFull
  const p2 = ctrl.onPartialReply({ text: "hi<qqimg>/tmp/x.jpg</qqimg>\n\n再见朋友" });

  // 等待所有处理完成
  await p1;
  await p2;
  await flush(800);

  // 标记完成
  ctrl.markFullyComplete();
  await ctrl.onIdle();
  await flush(300);

  // ★ 核心验证：最终发送的文本应包含 "再见朋友"
  const allStreamContent = streamCalls.map((c) => c.content).join(" || ");
  assert.ok(
    allStreamContent.includes("再见朋友"),
    `"再见朋友" 应出现在流式发送中（pendingNormalizedFull 补救）。\n实际流式内容: [\n${streamCalls.map((c, i) => `  ${i}: "${c.content.slice(0, 80)}" (state=${c.inputState})`).join("\n")}\n]`
  );
});

await test("补救: 多次被跳过只保留最新，最终处理最新文本", async () => {
  const ctrl = createController({ mediaContext: true });

  apiDelayMs = 30;
  mediaApiDelayMs = 150; // 媒体处理很慢

  // 第1次: 含媒体 → 进入长时间处理
  const p1 = ctrl.onPartialReply({ text: "<qqvoice>/tmp/song.mp3</qqvoice>" });
  await sleep(20);

  // 第2次: 被跳过 → pendingNormalizedFull = "..v1.."
  await ctrl.onPartialReply({ text: "<qqvoice>/tmp/song.mp3</qqvoice>\n后续文字v1" });
  await sleep(10);

  // 第3次: 被跳过 → pendingNormalizedFull 被覆盖为 "..v2.."
  await ctrl.onPartialReply({ text: "<qqvoice>/tmp/song.mp3</qqvoice>\n后续文字v2最终版" });

  await p1;
  await flush(800);

  ctrl.markFullyComplete();
  await ctrl.onIdle();
  await flush(300);

  // ★ 核心验证：最终应包含 v2 的文本
  const allStreamContent = streamCalls.map((c) => c.content).join(" || ");
  assert.ok(
    allStreamContent.includes("后续文字v2最终版"),
    `应包含最新的 "后续文字v2最终版"。\n实际: [\n${streamCalls.map((c, i) => `  ${i}: "${c.content.slice(0, 80)}" (state=${c.inputState})`).join("\n")}\n]`
  );
});

await test("补救: 无 pending 时不触发多余的 re-run", async () => {
  const ctrl = createController({ mediaContext: true });

  apiDelayMs = 5;
  mediaApiDelayMs = 5;

  // 只有一次 onPartialReply（媒体标签后接 \n 开头的文本）
  await ctrl.onPartialReply({ text: "hello<qqimg>/tmp/a.jpg</qqimg>\nbye" });
  await flush(400);

  ctrl.markFullyComplete();
  await ctrl.onIdle();
  await flush(200);

  // 验证：不应有 re-running 日志（因为没有被跳过的调用）
  const reRunLogs = logs.filter((l) => l.includes("re-running"));
  assert.strictEqual(reRunLogs.length, 0, `不应有 re-running 日志，实际: ${reRunLogs.length}`);

  // ★ 验证：不应有 PREFIX MISMATCH 错误（之前 stripMediaTags 的 .trim() 会导致此问题）
  const prefixMismatchLogs = logs.filter((l) => l.includes("PREFIX MISMATCH"));
  assert.strictEqual(prefixMismatchLogs.length, 0, `不应有 PREFIX MISMATCH，实际: ${prefixMismatchLogs.join("; ")}`);
});

console.log("\n=== 6. onIdle 边界 ===");

await test("onIdle: 等待媒体处理完成后再终结", async () => {
  const ctrl = createController({ mediaContext: true });

  apiDelayMs = 20;
  mediaApiDelayMs = 200; // 媒体发送很慢

  // 发送含媒体的文本
  const p = ctrl.onPartialReply({ text: "<qqimg>/tmp/slow.jpg</qqimg>\n完成" });
  await sleep(30);

  // 在媒体还在处理时就标记完成并触发 onIdle
  ctrl.markFullyComplete();
  const idlePromise = ctrl.onIdle();

  await p;
  await idlePromise;
  await flush(500);

  // 验证：应该正常完成，不降级
  assert.ok(!ctrl.shouldFallbackToStatic, "不应降级到静态发送");
});

await test("onDeliver: deliver 先到达 → 禁用流式走降级", async () => {
  const ctrl = createController({ mediaContext: true });

  // deliver 先到达（此时 sentStreamChunkCount === 0）→ 直接 transition 到 aborted
  await ctrl.onDeliver({ text: "成果：<qqimg>/tmp/result.png</qqimg>" });
  await flush(400);

  // 验证：应该已经进入终态（aborted），走降级路径
  assert.ok(ctrl.isTerminalPhase, "deliver 先到达后应进入终态");
  assert.ok(ctrl.shouldFallbackToStatic, "deliver 先到达时应降级到静态发送");

  // 后续 onPartialReply 应被跳过（因为已是终态）
  await ctrl.onPartialReply({ text: "这段应该被忽略" });
  assert.ok(ctrl.shouldFallbackToStatic, "onPartialReply 应被跳过，仍然是降级状态");
});

await test("互斥: onPartialReply 先到 → onDeliver 被忽略（即使在媒体中断期间）", async () => {
  const ctrl = createController({ mediaContext: true });

  // onPartialReply 先到 → 锁定为 partial 模式
  await ctrl.onPartialReply({ text: "<qqvoice>/tmp/a.mp3</qqvoice>" });
  await flush(400);

  // 此时可能还在 mediaInterruptInProgress，sentStreamChunkCount 可能为 0
  // 但 onDeliver 应被忽略（因为 partial 先到）
  await ctrl.onDeliver({ text: "<qqvoice>/tmp/a.mp3</qqvoice>" });
  await flush(400);

  // 验证：不应降级（deliver 没有生效）
  assert.ok(!ctrl.shouldFallbackToStatic, "partial 先到时 deliver 不应导致降级");
  assert.ok(!ctrl.isTerminalPhase || ctrl.currentPhase !== "aborted",
    "不应因为 deliver 进入 aborted（onPartialReply 在处理中）");

  // 日志中应有 deliver 被拒绝的字样
  const skipLogs = logs.filter((l) => l.includes('rejected "deliver"'));
  assert.ok(skipLogs.length >= 1, `应有 deliver 被拒绝的日志，实际: ${skipLogs.join("; ") || "无"}`);
});

console.log("\n=== 7. 降级与异常 ===");

await test("降级: 从未发送分片 → fallback", async () => {
  const ctrl = createController();

  // 不发送任何文本就直接结束
  ctrl.markFullyComplete();
  await ctrl.onIdle();

  assert.ok(ctrl.isTerminalPhase, "应进入终态");
});

await test("异常: onError 后正常终态", async () => {
  const ctrl = createController();

  await ctrl.onPartialReply({ text: "部分文本" });
  await flush(200);

  await ctrl.onError(new Error("test error"));

  assert.ok(ctrl.isTerminalPhase, "onError 后应进入终态");
});

console.log("\n=== 8. 回复边界检测（拼接模式） ===");

await test("回复边界: 新回复拼接到旧内容后面，用两个换行分隔", async () => {
  const ctrl = createController();

  // 第一段回复
  await ctrl.onPartialReply({ text: "第一段回复" });
  await flush();

  // 验证初始状态
  const c = ctrl as any;
  assert.strictEqual(c.lastRawFull, "第一段回复", `lastRawFull 应为 "第一段回复"，实际: "${c.lastRawFull}"`);
  assert.strictEqual(c._boundaryPrefix, null, `初始 _boundaryPrefix 应为 null`);

  // 文本缩短（新回复来了）→ 触发边界检测 → 拼接
  await ctrl.onPartialReply({ text: "新" });
  await flush();

  // 验证边界拼接后的状态
  assert.strictEqual(c._boundaryPrefix, "第一段回复\n\n", `_boundaryPrefix 应为 "第一段回复\\n\\n"，实际: "${c._boundaryPrefix}"`);
  assert.strictEqual(c.lastRawFull, "第一段回复\n\n新", `lastRawFull 应为 "第一段回复\\n\\n新"，实际: "${c.lastRawFull}"`);
  assert.ok(c.lastNormalizedFull.includes("第一段回复"), `lastNormalizedFull 应包含第一段内容`);
  assert.ok(c.lastNormalizedFull.includes("新"), `lastNormalizedFull 应包含新回复内容`);

  // 新回复继续增长 → 不应再次触发边界
  await ctrl.onPartialReply({ text: "新回复增长了" });
  await flush();

  assert.strictEqual(c._boundaryPrefix, "第一段回复\n\n", `增长后 _boundaryPrefix 不应变化，实际: "${c._boundaryPrefix}"`);
  assert.strictEqual(c.lastRawFull, "第一段回复\n\n新回复增长了", `lastRawFull 应为 "第一段回复\\n\\n新回复增长了"，实际: "${c.lastRawFull}"`);

  // 继续增长
  await ctrl.onPartialReply({ text: "新回复增长了更多内容" });
  await flush();

  assert.strictEqual(c.lastRawFull, "第一段回复\n\n新回复增长了更多内容", `lastRawFull 应为拼接后的完整文本，实际: "${c.lastRawFull}"`);

  // 验证日志中只触发了一次边界检测
  const boundaryLogs = logs.filter((l) => l.includes("reply boundary detected"));
  assert.strictEqual(boundaryLogs.length, 1, `应只触发 1 次边界检测，实际: ${boundaryLogs.length}`);

  ctrl.markFullyComplete();
  await ctrl.onIdle();
  await flush();

  // 验证最终发送的内容同时包含两段
  const allContent = streamCalls.map((c) => c.content).join(" || ");
  assert.ok(allContent.includes("第一段回复"), `最终发送应包含 "第一段回复"，实际: ${allContent}`);
  assert.ok(allContent.includes("新回复增长了更多内容"), `最终发送应包含 "新回复增长了更多内容"，实际: ${allContent}`);

  // 旧 controller 不应进入 aborted，应正常 completed
  assert.ok(ctrl.isTerminalPhase, "应进入终态");
  assert.ok(!ctrl.shouldFallbackToStatic, "不应降级");
});

await test("回复边界: 多次边界拼接（三段回复）", async () => {
  const ctrl = createController();

  // 第一段
  await ctrl.onPartialReply({ text: "AAA" });
  await flush();

  const c = ctrl as any;
  assert.strictEqual(c.lastRawFull, "AAA");
  assert.strictEqual(c._boundaryPrefix, null);

  // 第二段（第一次边界）
  await ctrl.onPartialReply({ text: "BBB" });
  await flush();

  assert.strictEqual(c._boundaryPrefix, "AAA\n\n", `第一次边界后 _boundaryPrefix 应为 "AAA\\n\\n"，实际: "${c._boundaryPrefix}"`);
  assert.strictEqual(c.lastRawFull, "AAA\n\nBBB", `第一次边界后 lastRawFull 应为 "AAA\\n\\nBBB"，实际: "${c.lastRawFull}"`);

  // 第二段继续增长
  await ctrl.onPartialReply({ text: "BBB完整" });
  await flush();

  assert.strictEqual(c.lastRawFull, "AAA\n\nBBB完整", `增长后 lastRawFull 应为 "AAA\\n\\nBBB完整"，实际: "${c.lastRawFull}"`);

  // 第三段（第二次边界）
  await ctrl.onPartialReply({ text: "CCC" });
  await flush();

  assert.strictEqual(c._boundaryPrefix, "AAA\n\nBBB完整\n\n", `第二次边界后 _boundaryPrefix 应为 "AAA\\n\\nBBB完整\\n\\n"，实际: "${c._boundaryPrefix}"`);
  assert.strictEqual(c.lastRawFull, "AAA\n\nBBB完整\n\nCCC", `第二次边界后 lastRawFull 应为 "AAA\\n\\nBBB完整\\n\\nCCC"，实际: "${c.lastRawFull}"`);

  // 第三段继续增长
  await ctrl.onPartialReply({ text: "CCC结束" });
  await flush();

  assert.strictEqual(c.lastRawFull, "AAA\n\nBBB完整\n\nCCC结束");

  // 验证总共触发了 2 次边界检测
  const boundaryLogs = logs.filter((l) => l.includes("reply boundary detected"));
  assert.strictEqual(boundaryLogs.length, 2, `应触发 2 次边界检测，实际: ${boundaryLogs.length}`);

  ctrl.markFullyComplete();
  await ctrl.onIdle();
  await flush();

  // 验证最终发送的内容包含三段
  const allContent = streamCalls.map((c) => c.content).join(" || ");
  assert.ok(allContent.includes("AAA"), `应包含 "AAA"`);
  assert.ok(allContent.includes("BBB完整"), `应包含 "BBB完整"`);
  assert.ok(allContent.includes("CCC结束"), `应包含 "CCC结束"`);
});

await test("回复边界: 边界后 sentIndex 不受影响，内容连续发送", async () => {
  const ctrl = createController();

  // 第一段回复足够长，确保流式已启动
  await ctrl.onPartialReply({ text: "第一段比较长的回复内容" });
  await flush(200);

  const c = ctrl as any;
  const sentIndexBefore = c.sentIndex;

  // 触发边界
  await ctrl.onPartialReply({ text: "第二段" });
  await flush(200);

  // sentIndex 不应被重置（因为是在同一个流式会话中继续）
  assert.ok(c.sentIndex >= sentIndexBefore, `边界后 sentIndex (${c.sentIndex}) 应 >= 边界前 (${sentIndexBefore})`);

  // 验证流式会话没有中断（streamMsgId 应不变）
  // 边界不会导致流式会话终结和重建
  assert.ok(c.streamMsgId !== null, `边界后 streamMsgId 应仍存在，实际: ${c.streamMsgId}`);

  ctrl.markFullyComplete();
  await ctrl.onIdle();
  await flush();
});

// ============ 结果 ============

console.log(`\n========================================`);
console.log(`  总计: ${passed + failed} | ✅ 通过: ${passed} | ❌ 失败: ${failed}`);
if (failedTests.length > 0) {
  console.log(`  失败用例:`);
  for (const t of failedTests) console.log(`    - ${t}`);
}
console.log(`========================================\n`);

// 恢复原始 fetch
globalThis.fetch = originalFetch;

process.exit(failed > 0 ? 1 : 0);
