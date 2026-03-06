/**
 * 富媒体标签预处理与纠错
 *
 * 小模型常见的标签拼写错误及变体，在正则匹配前统一修正为标准格式。
 */

// 标准标签名
const VALID_TAGS = ["qqimg", "qqvoice", "qqvideo", "qqfile"] as const;

// 开头标签别名映射（key 全部小写）
const TAG_ALIASES: Record<string, typeof VALID_TAGS[number]> = {
  // ---- qqimg 变体 ----
  "qq_img": "qqimg",
  "qqimage": "qqimg",
  "qq_image": "qqimg",
  "qqpic": "qqimg",
  "qq_pic": "qqimg",
  "qqpicture": "qqimg",
  "qq_picture": "qqimg",
  "qqphoto": "qqimg",
  "qq_photo": "qqimg",
  "img": "qqimg",
  "image": "qqimg",
  "pic": "qqimg",
  "picture": "qqimg",
  "photo": "qqimg",
  // ---- qqvoice 变体 ----
  "qq_voice": "qqvoice",
  "qqaudio": "qqvoice",
  "qq_audio": "qqvoice",
  "voice": "qqvoice",
  "audio": "qqvoice",
  // ---- qqvideo 变体 ----
  "qq_video": "qqvideo",
  "video": "qqvideo",
  // ---- qqfile 变体 ----
  "qq_file": "qqfile",
  "qqdoc": "qqfile",
  "qq_doc": "qqfile",
  "file": "qqfile",
  "doc": "qqfile",
  "document": "qqfile",
};

// 构建所有可识别的标签名列表（标准名 + 别名）
const ALL_TAG_NAMES = [...VALID_TAGS, ...Object.keys(TAG_ALIASES)];
// 按长度降序排列，优先匹配更长的名称（避免 "img" 抢先匹配 "qqimg" 的子串）
ALL_TAG_NAMES.sort((a, b) => b.length - a.length);

const TAG_NAME_PATTERN = ALL_TAG_NAMES.join("|");

/**
 * 构建一个宽容的正则，能匹配各种畸形标签写法：
 *
 * 常见错误模式：
 *  1. 标签名拼错：<qq_img>, <qqimage>, <image>, <img>, <pic> ...
 *  2. 标签内多余空格：<qqimg >, < qqimg>, <qqimg >
 *  3. 闭合标签不匹配：<qqimg>url</qqvoice>, <qqimg>url</img>
 *  4. 闭合标签缺失斜杠：<qqimg>url<qqimg> (用开头标签代替闭合标签)
 *  5. 闭合标签缺失尖括号：<qqimg>url/qqimg>
 *  6. 中文尖括号：＜qqimg＞url＜/qqimg＞ 或 <qqimg>url</qqimg>
 *  7. 多余引号包裹路径：<qqimg>"path"</qqimg>
 *  8. Markdown 代码块包裹：`<qqimg>path</qqimg>`
 */
const FUZZY_MEDIA_TAG_REGEX = new RegExp(
  // 可选 Markdown 行内代码反引号
  "`?" +
  // 开头标签：允许中文/英文尖括号，标签名前后可有空格
  "[<＜<]\\s*(" + TAG_NAME_PATTERN + ")\\s*[>＞>]" +
  // 内容：非贪婪匹配，允许引号包裹
  "[\"']?\\s*" +
  "([^<＜<＞>\"'`]+?)" +
  "\\s*[\"']?" +
  // 闭合标签：允许各种不规范写法
  "[<＜<]\\s*/?\\s*(?:" + TAG_NAME_PATTERN + ")\\s*[>＞>]" +
  // 可选结尾反引号
  "`?",
  "gi"
);

/**
 * 将标签名映射为标准名称
 */
function resolveTagName(raw: string): typeof VALID_TAGS[number] {
  const lower = raw.toLowerCase();
  if ((VALID_TAGS as readonly string[]).includes(lower)) {
    return lower as typeof VALID_TAGS[number];
  }
  return TAG_ALIASES[lower] ?? "qqimg";
}

/**
 * 预处理 LLM 输出文本，将各种畸形/错误的富媒体标签修正为标准格式。
 *
 * 标准格式：<qqimg>/path/to/file</qqimg>
 *
 * @param text LLM 原始输出
 * @returns 修正后的文本（如果没有匹配到任何标签则原样返回）
 */
export function normalizeMediaTags(text: string): string {
  return text.replace(FUZZY_MEDIA_TAG_REGEX, (_match, rawTag: string, content: string) => {
    const tag = resolveTagName(rawTag);
    const trimmed = content.trim();
    if (!trimmed) return _match; // 空内容不处理
    return `<${tag}>${trimmed}</${tag}>`;
  });
}
