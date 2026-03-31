/**
 * 代码块内媒体标签检测 — 单元测试
 *
 * 覆盖 isInsideCodeBlock / hasMediaTags / findFirstClosedMediaTag / splitByMediaTags
 * 确保围栏代码块（```）内的媒体标签不会被误识别。
 *
 * 运行方式:  npx tsx tests/code-block-media-tag.test.ts
 */

import {
  isInsideCodeBlock,
  hasMediaTags,
  findFirstClosedMediaTag,
  splitByMediaTags,
} from "../src/utils/media-send.js";
import assert from "node:assert";

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

// ============ 辅助 ============

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

/** isInsideCodeBlock 断言 */
function testInside(name: string, text: string, position: number, expected: boolean) {
  try {
    const result = isInsideCodeBlock(text, position);
    assert.strictEqual(result, expected);
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     文本:     ${JSON.stringify(text)}`);
    console.log(`     位置:     ${position}`);
    console.log(`     期望:     ${expected}`);
    console.log(`     实际:     ${!expected}`);
    failed++;
    failedTests.push(name);
  }
}

/** hasMediaTags 断言 */
function testHas(name: string, text: string, expected: boolean) {
  try {
    const result = hasMediaTags(text);
    assert.strictEqual(result, expected);
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     文本:     ${JSON.stringify(text)}`);
    console.log(`     期望:     ${expected}`);
    console.log(`     实际:     ${!expected}`);
    failed++;
    failedTests.push(name);
  }
}

/** findFirstClosedMediaTag 断言（简化：检查返回值是否为 null，以及如果非 null 检查 mediaPath） */
function testFind(
  name: string,
  text: string,
  expected: { found: false } | { found: true; mediaPath: string; tagName: string },
) {
  try {
    const result = findFirstClosedMediaTag(text);
    if (!expected.found) {
      assert.strictEqual(result, null, `期望返回 null`);
    } else {
      assert.notStrictEqual(result, null, `期望找到标签`);
      assert.strictEqual(result!.mediaPath, expected.mediaPath, `mediaPath 不匹配`);
      assert.strictEqual(result!.tagName, expected.tagName, `tagName 不匹配`);
    }
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     文本:     ${JSON.stringify(text)}`);
    console.log(`     期望:     ${JSON.stringify(expected)}`);
    console.log(`     实际:     ${JSON.stringify(findFirstClosedMediaTag(text))}`);
    failed++;
    failedTests.push(name);
  }
}

/** splitByMediaTags 断言 */
function testSplit(
  name: string,
  text: string,
  expectedHasMedia: boolean,
  expectedQueueLength?: number,
) {
  try {
    const result = splitByMediaTags(text);
    assert.strictEqual(result.hasMediaTags, expectedHasMedia, `hasMediaTags 不匹配`);
    if (expectedQueueLength !== undefined) {
      assert.strictEqual(result.mediaQueue.length, expectedQueueLength, `mediaQueue 长度不匹配`);
    }
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     文本:     ${JSON.stringify(text)}`);
    console.log(`     期望:     hasMedia=${expectedHasMedia}, queueLen=${expectedQueueLength}`);
    const r = splitByMediaTags(text);
    console.log(`     实际:     hasMedia=${r.hasMediaTags}, queueLen=${r.mediaQueue.length}`);
    failed++;
    failedTests.push(name);
  }
}

// ======================================================================
//  Part 1: isInsideCodeBlock — 围栏代码块
// ======================================================================
group("1.1 围栏代码块 — 基本场景");

{
  const text = "前文\n```\n<qqimg>/a.png</qqimg>\n```\n后文";
  const tagPos = text.indexOf("<qqimg>");
  testInside("围栏内的标签应返回 true", text, tagPos, true);
  testInside("围栏前的文本应返回 false", text, 0, false);
  testInside("围栏后的文本应返回 false", text, text.indexOf("后文"), false);
}

group("1.2 围栏代码块 — 带语言标识");

{
  const text = "说明\n```html\n<qqimg>/path/to/img.png</qqimg>\n```\n结束";
  const tagPos = text.indexOf("<qqimg>");
  testInside("```html 围栏内的标签应返回 true", text, tagPos, true);
}

{
  const text = "说明\n```xml\n<qqvoice>/path/to/voice.mp3</qqvoice>\n```\n结束";
  const tagPos = text.indexOf("<qqvoice>");
  testInside("```xml 围栏内的标签应返回 true", text, tagPos, true);
}

{
  const text = "说明\n```javascript\nconsole.log('<qqimg>/x.png</qqimg>');\n```\n结束";
  const tagPos = text.indexOf("<qqimg>");
  testInside("```javascript 围栏内的标签应返回 true", text, tagPos, true);
}

group("1.3 围栏代码块 — 多个围栏");

{
  const text = "前\n```\ncode1\n```\n中间\n```\n<qqimg>/b.png</qqimg>\n```\n后";
  const tagPos = text.indexOf("<qqimg>");
  const midPos = text.indexOf("中间");
  testInside("第二个围栏内的标签应返回 true", text, tagPos, true);
  testInside("两个围栏之间的文本应返回 false", text, midPos, false);
}

group("1.4 围栏代码块 — 未闭合围栏");

{
  const text = "前文\n```\n<qqimg>/c.png</qqimg>\n剩余内容";
  const tagPos = text.indexOf("<qqimg>");
  testInside("未闭合围栏内应返回 true", text, tagPos, true);
  testInside("未闭合围栏后面的内容也应返回 true", text, text.indexOf("剩余内容"), true);
  testInside("未闭合围栏前的文本应返回 false", text, 0, false);
}

group("1.5 围栏代码块 — 四反引号围栏");

{
  const text = "前文\n````\n<qqimg>/d.png</qqimg>\n````\n后文";
  const tagPos = text.indexOf("<qqimg>");
  testInside("四反引号围栏内标签应返回 true", text, tagPos, true);
  testInside("四反引号围栏后文本应返回 false", text, text.indexOf("后文"), false);
}

group("1.6 围栏代码块 — 四反引号包裹三反引号");

{
  const text = '前文\n````\n```\n<qqimg>/e.png</qqimg>\n```\n````\n后文';
  const tagPos = text.indexOf("<qqimg>");
  testInside("四反引号内嵌三反引号，标签应在外层围栏内返回 true", text, tagPos, true);
  testInside("四反引号围栏后文本应返回 false", text, text.indexOf("后文"), false);
}

group("1.7 围栏代码块 — 围栏开始/结束位置边界");

{
  const text = "```\ncontent\n```";
  // ``` 本身的第一个字符
  testInside("围栏开头 ` 处应返回 true", text, 0, true);
  // ``` 内容区
  testInside("围栏内容 content 应返回 true", text, text.indexOf("content"), true);
  // 闭合 ``` 的位置（仍在围栏范围内）
  testInside("闭合 ``` 位置仍在围栏范围内应返回 true", text, text.lastIndexOf("```"), true);
}

// ======================================================================
//  Part 2: isInsideCodeBlock — 特殊/边界场景
// ======================================================================
group("2.1 空文本");

testInside("空文本位置0应返回 false", "", 0, false);

group("2.2 纯代码块无媒体标签");

{
  const text = "```\nconst x = 1;\n```";
  testInside("代码块内普通代码应返回 true", text, text.indexOf("const"), true);
}

group("2.3 代码块前后紧邻标签");

{
  const text = "<qqimg>/before.png</qqimg>\n```\ncode\n```\n<qqimg>/after.png</qqimg>";
  const beforePos = text.indexOf("<qqimg>/before.png");
  const afterPos = text.indexOf("<qqimg>/after.png");
  testInside("围栏前的标签应返回 false", text, beforePos, false);
  testInside("围栏后的标签应返回 false", text, afterPos, false);
}

group("2.4 连续多个围栏代码块");

{
  const text = "```\na\n```\n```\nb\n```\n```\n<qqimg>/c.png</qqimg>\n```";
  const tagPos = text.indexOf("<qqimg>");
  testInside("第三个围栏内标签应返回 true", text, tagPos, true);
}

group("2.5 围栏内含反引号");

{
  const text = "```\n这里有 `反引号` 和 <qqimg>/x.png</qqimg>\n```";
  const tagPos = text.indexOf("<qqimg>");
  testInside("围栏内的反引号不影响判断，标签应返回 true", text, tagPos, true);
}

group("2.6 空围栏代码块");

{
  const text = "前\n```\n```\n<qqimg>/a.png</qqimg>";
  const tagPos = text.indexOf("<qqimg>");
  testInside("空围栏后的标签应返回 false", text, tagPos, false);
}

group("2.7 围栏代码块 — 只有开始标记，文本结尾");

{
  const text = "```";
  testInside("只有 ``` 的文本，位置0应返回 true", text, 0, true);
}

// ======================================================================
//  Part 4: hasMediaTags — 代码块过滤
// ======================================================================
group("4.1 hasMediaTags — 纯文本无标签");

testHas("纯文本应返回 false", "这只是普通文本", false);
testHas("空字符串应返回 false", "", false);

group("4.2 hasMediaTags — 代码块外标签");

testHas("普通 qqimg 标签", "<qqimg>/path/img.png</qqimg>", true);
testHas("普通 qqvoice 标签", "<qqvoice>/path/voice.mp3</qqvoice>", true);
testHas("普通 qqvideo 标签", "<qqvideo>/path/video.mp4</qqvideo>", true);
testHas("普通 qqfile 标签", "<qqfile>/path/file.txt</qqfile>", true);
testHas("普通 qqmedia 标签", "<qqmedia>/path/media.bin</qqmedia>", true);

group("4.3 hasMediaTags — 围栏代码块内标签");

testHas(
  "围栏内 qqimg 应返回 false",
  "前文\n```\n<qqimg>/path/img.png</qqimg>\n```\n后文",
  false,
);

testHas(
  "围栏内 qqvoice 应返回 false",
  "示例代码：\n```\n<qqvoice>/tmp/voice.mp3</qqvoice>\n```",
  false,
);

testHas(
  "```html 围栏内标签应返回 false",
  "代码示例\n```html\n<qqimg>/path/img.png</qqimg>\n```",
  false,
);

testHas(
  "未闭合围栏内标签应返回 false",
  "代码：\n```\n<qqimg>/path/img.png</qqimg>",
  false,
);

group("4.4 hasMediaTags — 混合场景（代码块内+代码块外）");

testHas(
  "代码块内+代码块外各一个标签应返回 true",
  "```\n<qqimg>/in-code.png</qqimg>\n```\n<qqimg>/outside.png</qqimg>",
  true,
);

group("4.5 hasMediaTags — 多个标签全部在代码块内");

testHas(
  "多个标签全在围栏内应返回 false",
  "```\n<qqimg>/a.png</qqimg>\n<qqvoice>/b.mp3</qqvoice>\n<qqfile>/c.txt</qqfile>\n```",
  false,
);

group("4.6 hasMediaTags — 多个标签全部在代码块外");

testHas(
  "多个标签全在外面应返回 true",
  "看这个 <qqimg>/a.png</qqimg> 和 <qqvoice>/b.mp3</qqvoice>",
  true,
);

// ======================================================================
//  Part 5: findFirstClosedMediaTag — 代码块过滤
// ======================================================================
group("5.1 findFirstClosedMediaTag — 无标签");

testFind("纯文本无标签", "普通文本", { found: false });
testFind("空字符串", "", { found: false });

group("5.2 findFirstClosedMediaTag — 代码块外标签");

testFind(
  "普通 qqimg 标签",
  "前文 <qqimg>/path/img.png</qqimg> 后文",
  { found: true, mediaPath: "/path/img.png", tagName: "qqimg" },
);

testFind(
  "qqvoice 标签",
  "<qqvoice>/voice.mp3</qqvoice>",
  { found: true, mediaPath: "/voice.mp3", tagName: "qqvoice" },
);

testFind(
  "qqvideo 标签",
  "<qqvideo>/video.mp4</qqvideo>",
  { found: true, mediaPath: "/video.mp4", tagName: "qqvideo" },
);

testFind(
  "qqfile 标签",
  "<qqfile>/file.txt</qqfile>",
  { found: true, mediaPath: "/file.txt", tagName: "qqfile" },
);

testFind(
  "qqmedia 标签",
  "<qqmedia>/media.bin</qqmedia>",
  { found: true, mediaPath: "/media.bin", tagName: "qqmedia" },
);

group("5.3 findFirstClosedMediaTag — 围栏代码块内标签");

testFind(
  "围栏内标签应返回 null",
  "前文\n```\n<qqimg>/in-code.png</qqimg>\n```\n后文",
  { found: false },
);

testFind(
  "未闭合围栏内标签应返回 null",
  "代码\n```\n<qqimg>/path.png</qqimg>",
  { found: false },
);

testFind(
  "带语言标识的围栏内标签应返回 null",
  "```html\n<qqimg>/img.png</qqimg>\n```",
  { found: false },
);

group("5.4 findFirstClosedMediaTag — 跳过代码块内，找到代码块外的");

testFind(
  "第一个在围栏内，第二个在围栏外",
  "```\n<qqimg>/inside.png</qqimg>\n```\n<qqimg>/outside.png</qqimg>",
  { found: true, mediaPath: "/outside.png", tagName: "qqimg" },
);

testFind(
  "多个围栏代码块内标签后接一个外部标签",
  "```\n<qqimg>/a.png</qqimg>\n<qqvoice>/b.mp3</qqvoice>\n```\n<qqvideo>/d.mp4</qqvideo>",
  { found: true, mediaPath: "/d.mp4", tagName: "qqvideo" },
);

group("5.5 findFirstClosedMediaTag — 所有标签都在代码块内");

testFind(
  "围栏全包裹",
  "```\n<qqimg>/a.png</qqimg>\n```",
  { found: false },
);

group("5.6 findFirstClosedMediaTag — textBefore 正确性");

{
  const text = "前面一些文字\n```\n<qqimg>/skip.png</qqimg>\n```\n中间文字 <qqimg>/real.png</qqimg> 后";
  const result = findFirstClosedMediaTag(text);
  try {
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.tagName, "qqimg");
    assert.strictEqual(result!.mediaPath, "/real.png");
    // textBefore 应该包含围栏代码块在内的所有前面的文本
    assert.ok(result!.textBefore.includes("前面一些文字"));
    assert.ok(result!.textBefore.includes("```"));
    assert.ok(result!.textBefore.includes("中间文字"));
    console.log(`  ✅ textBefore 包含代码块和中间文字`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ textBefore 包含代码块和中间文字`);
    console.log(`     实际 textBefore: ${JSON.stringify(result?.textBefore)}`);
    failed++;
    failedTests.push("textBefore 包含代码块和中间文字");
  }
}

// ======================================================================
//  Part 6: splitByMediaTags — 代码块过滤
// ======================================================================
group("6.1 splitByMediaTags — 无标签");

testSplit("纯文本", "没有标签的文本", false, 0);
testSplit("空字符串", "", false, 0);

group("6.2 splitByMediaTags — 代码块外标签");

testSplit("一个外部标签", "<qqimg>/a.png</qqimg>", true, 1);
testSplit(
  "两个外部标签（queue含标签间文本）",
  "<qqimg>/a.png</qqimg> 中间 <qqvoice>/b.mp3</qqvoice>",
  true,
  3, // 2个媒体 + 1个中间文本
);

group("6.3 splitByMediaTags — 全部在代码块内");

testSplit(
  "围栏内一个标签",
  "前文\n```\n<qqimg>/a.png</qqimg>\n```\n后文",
  false,
  0,
);

testSplit(
  "围栏内多个标签",
  "```\n<qqimg>/a.png</qqimg>\n<qqvoice>/b.mp3</qqvoice>\n```",
  false,
  0,
);

group("6.4 splitByMediaTags — 混合：部分在代码块内，部分在外");

testSplit(
  "围栏内1个+外面1个",
  "```\n<qqimg>/inside.png</qqimg>\n```\n<qqimg>/outside.png</qqimg>",
  true,
  1,
);

group("6.5 splitByMediaTags — textBeforeFirstTag / textAfterLastTag");

{
  const text = "前面文字\n```\n<qqimg>/skip.png</qqimg>\n```\n中间 <qqimg>/real.png</qqimg> 后面";
  const result = splitByMediaTags(text);
  try {
    assert.strictEqual(result.hasMediaTags, true);
    assert.strictEqual(result.mediaQueue.length, 1);
    assert.ok(result.textBeforeFirstTag.includes("前面文字"), "textBeforeFirstTag 应包含前面文字");
    assert.ok(result.textBeforeFirstTag.includes("中间"), "textBeforeFirstTag 应包含中间文字");
    assert.strictEqual(result.textAfterLastTag, "后面");
    console.log(`  ✅ split 的 textBefore/After 在代码块过滤后正确`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ split 的 textBefore/After 在代码块过滤后正确`);
    console.log(`     before: ${JSON.stringify(result.textBeforeFirstTag)}`);
    console.log(`     after:  ${JSON.stringify(result.textAfterLastTag)}`);
    console.log(`     queue:  ${JSON.stringify(result.mediaQueue)}`);
    failed++;
    failedTests.push("split 的 textBefore/After 在代码块过滤后正确");
  }
}

// ======================================================================
//  Part 7: 综合 / 真实场景测试
// ======================================================================
group("7.1 LLM 输出中示范用法（围栏包裹）");

{
  const text = `你好！下面是使用方法：

\`\`\`
<qqimg>/path/to/image.png</qqimg>
\`\`\`

以上就是示例。`;

  testHas("LLM示范用法，围栏内不应视为标签", text, false);
  testFind("LLM示范用法find应返回null", text, { found: false });
  testSplit("LLM示范用法split应无标签", text, false, 0);
}

group("7.2 LLM 输出中先示范再真正发送");

{
  const text = `你好！用法如下：

\`\`\`
<qqimg>/example/demo.png</qqimg>
\`\`\`

下面我发送真正的图片：
<qqimg>/real/photo.jpg</qqimg>`;

  testHas("示范+真实发送，应有标签", text, true);
  testFind(
    "示范+真实发送，find应跳过示范找到真实标签",
    text,
    { found: true, mediaPath: "/real/photo.jpg", tagName: "qqimg" },
  );
  testSplit("示范+真实发送，split只含1个媒体", text, true, 1);
}

group("7.3 多种标签混合在围栏内");

{
  const text = `示例代码：

\`\`\`
<qqimg>/img.png</qqimg>
<qqvoice>/voice.mp3</qqvoice>
<qqvideo>/video.mp4</qqvideo>
<qqfile>/file.txt</qqfile>
<qqmedia>/media.bin</qqmedia>
\`\`\`

以上是所有支持的标签类型。`;

  testHas("所有标签类型在围栏内应返回 false", text, false);
  testFind("所有标签类型在围栏内find应返回 null", text, { found: false });
}

group("7.4 围栏内标签夹杂普通HTML标签");

{
  const text = "```html\n<div><qqimg>/img.png</qqimg></div>\n```";
  testHas("围栏内HTML混合媒体标签应返回 false", text, false);
}

group("7.5 代码块内标签有额外空白/换行");

{
  const text = "```\n  <qqimg>  /path/img.png  </qqimg>  \n```";
  testHas("围栏内带空白的标签应返回 false", text, false);
}

group("7.6 连续围栏，每个都有标签");

{
  const text = "```\n<qqimg>/a.png</qqimg>\n```\n\n```\n<qqvoice>/b.mp3</qqvoice>\n```\n\n```\n<qqfile>/c.txt</qqfile>\n```";
  testHas("多个围栏各有标签都应返回 false", text, false);
  testFind("多个围栏各有标签find应返回 null", text, { found: false });
  testSplit("多个围栏各有标签split无标签", text, false, 0);
}

group("7.7 围栏代码块紧邻无换行");

{
  // 标准 Markdown 围栏需要在行首，这里测试紧凑格式
  const text = "文本```\n<qqimg>/a.png</qqimg>\n```结尾";
  // 注意：如果 ``` 不在行首，不算围栏，标签应该能被检测到
  // 但我们的正则是 /^(`{3,})[^\n]*$/gm，^ 匹配行首，所以 "文本```" 不算围栏开始
  testHas("```不在行首，标签应正常检测", text, true);
}

group("7.8 Windows 风格换行 CRLF");

{
  const text = "前文\r\n```\r\n<qqimg>/a.png</qqimg>\r\n```\r\n后文";
  const tagPos = text.indexOf("<qqimg>");
  // CRLF 情况下 ``` 是否在行首取决于正则的 m 标志
  // /^(`{3,})[^\n]*$/gm 中 ^ 在 m 模式下匹配 \n 后，\r\n 中 \r 可能影响
  // 但 ```\r 可能匹配为 `{3,}[^\n]*$ → ``` 后跟 \r
  testInside("CRLF围栏内标签检测", text, tagPos, true);
}

group("7.9 标签跨行（不闭合）在围栏外");

{
  // 媒体标签正则不匹配跨行标签，所以不会匹配到
  const text = "<qqimg>\n/path/img.png\n</qqimg>";
  testHas("跨行标签会被 normalize 压缩为单行，应返回 true", text, true);
}

group("7.10 大小写混合标签");

{
  const text = "```\n<QQImg>/a.png</QQImg>\n```";
  testHas("围栏内大小写混合标签应返回 false", text, false);
}

{
  const text = "<QQIMG>/a.png</QQIMG>";
  testHas("外部大小写混合标签应返回 true", text, true);
}

group("7.11 代码块后紧接多个外部标签");

{
  const text = "```\n示例\n```\n<qqimg>/a.png</qqimg><qqvoice>/b.mp3</qqvoice><qqfile>/c.txt</qqfile>";
  testHas("代码块后多个连续标签应返回 true", text, true);
  testFind(
    "代码块后多个连续标签find应返回第一个",
    text,
    { found: true, mediaPath: "/a.png", tagName: "qqimg" },
  );
  testSplit("代码块后多个连续标签split应有3个", text, true, 3);
}

group("7.12 img 标签（别名）");

{
  const text = "```\n<img>/a.png</img>\n```";
  testHas("围栏内 img 标签应返回 false", text, false);
}

{
  const text = "<img>/a.png</img>";
  testHas("外部 img 标签应返回 true", text, true);
  testFind("外部 img 标签find应找到", text, { found: true, mediaPath: "/a.png", tagName: "img" });
}

group("7.13 围栏内标签路径含特殊字符");

{
  const text = "```\n<qqimg>/路径/中文 图片(1).png</qqimg>\n```";
  testHas("围栏内含中文路径的标签应返回 false", text, false);
}

// ======================================================================
//  结果汇总
// ======================================================================

console.log("\n" + "=".repeat(50));
console.log(`测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
if (failedTests.length > 0) {
  console.log(`\n失败的测试用例:`);
  for (const name of failedTests) {
    console.log(`  - ${name}`);
  }
}
console.log("=".repeat(50));

process.exit(failed > 0 ? 1 : 0);
