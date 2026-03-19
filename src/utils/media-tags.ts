/**
 * 富媒体标签预处理与纠错
 *
 * 统一使用 <qqmedia> 标签，后端根据文件后缀 / Content-Type 自动判断媒体类型。
 * 同时向后兼容旧标签名（qqimg / qqvoice / qqvideo / qqfile）。
 */

import * as path from "node:path";
import { expandTilde } from "./platform.js";
import { isAudioFile } from "./audio-convert.js";

// 统一标签名
const CANONICAL_TAG = "qqmedia" as const;

// 所有可识别的标签名（标准名 + 旧名 + 别名），全部映射到 qqmedia
const TAG_ALIASES: Record<string, string> = {
  // 统一标签
  "qqmedia": CANONICAL_TAG,
  "qq_media": CANONICAL_TAG,
  "media": CANONICAL_TAG,
  // ---- 旧 qqimg 及变体 ----
  "qqimg": CANONICAL_TAG,
  "qq_img": CANONICAL_TAG,
  "qqimage": CANONICAL_TAG,
  "qq_image": CANONICAL_TAG,
  "qqpic": CANONICAL_TAG,
  "qq_pic": CANONICAL_TAG,
  "qqpicture": CANONICAL_TAG,
  "qq_picture": CANONICAL_TAG,
  "qqphoto": CANONICAL_TAG,
  "qq_photo": CANONICAL_TAG,
  "img": CANONICAL_TAG,
  "image": CANONICAL_TAG,
  "pic": CANONICAL_TAG,
  "picture": CANONICAL_TAG,
  "photo": CANONICAL_TAG,
  // ---- 旧 qqvoice 及变体 ----
  "qqvoice": CANONICAL_TAG,
  "qq_voice": CANONICAL_TAG,
  "qqaudio": CANONICAL_TAG,
  "qq_audio": CANONICAL_TAG,
  "voice": CANONICAL_TAG,
  "audio": CANONICAL_TAG,
  // ---- 旧 qqvideo 及变体 ----
  "qqvideo": CANONICAL_TAG,
  "qq_video": CANONICAL_TAG,
  "video": CANONICAL_TAG,
  // ---- 旧 qqfile 及变体 ----
  "qqfile": CANONICAL_TAG,
  "qq_file": CANONICAL_TAG,
  "qqdoc": CANONICAL_TAG,
  "qq_doc": CANONICAL_TAG,
  "file": CANONICAL_TAG,
  "doc": CANONICAL_TAG,
  "document": CANONICAL_TAG,
};

// 构建所有可识别的标签名列表
const ALL_TAG_NAMES = Object.keys(TAG_ALIASES);
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
 * 预清理：将富媒体标签内部的换行/回车/制表符压缩为单个空格。
 */
const MULTILINE_TAG_CLEANUP = new RegExp(
  "([<＜<]\\s*(?:" + TAG_NAME_PATTERN + ")\\s*[>＞>])" +
  "([\\s\\S]*?)" +
  "([<＜<]\\s*/?\\s*(?:" + TAG_NAME_PATTERN + ")\\s*[>＞>])",
  "gi"
);

/**
 * 预处理 LLM 输出文本，将各种畸形/错误的富媒体标签统一修正为 <qqmedia>。
 *
 * @param text LLM 原始输出
 * @returns 修正后的文本（如果没有匹配到任何标签则原样返回）
 */
export function normalizeMediaTags(text: string): string {
  // 先将标签内部的换行/回车/制表符压缩为空格
  let cleaned = text.replace(MULTILINE_TAG_CLEANUP, (_m, open: string, body: string, close: string) => {
    const flat = body.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ");
    return open + flat + close;
  });

  return cleaned.replace(FUZZY_MEDIA_TAG_REGEX, (_match, rawTag: string, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return _match;
    const expanded = expandTilde(trimmed);
    return `<${CANONICAL_TAG}>${expanded}</${CANONICAL_TAG}>`;
  });
}

// ---- 媒体类型自动检测 ----

export type MediaType = "image" | "voice" | "video" | "file";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".ico", ".tiff", ".tif"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v", ".3gp"]);

/**
 * 根据文件后缀判断媒体类型（本地路径或 URL 均可）。
 * 对 URL 会先去掉 query/fragment 再取扩展名。
 */
export function detectMediaTypeByExt(resource: string): MediaType {
  let ext: string;
  try {
    // 对 URL 先解析出 pathname
    if (/^https?:\/\//i.test(resource)) {
      const u = new URL(resource);
      ext = path.extname(u.pathname).toLowerCase();
    } else {
      ext = path.extname(resource).toLowerCase();
    }
  } catch {
    ext = path.extname(resource).toLowerCase();
  }
  if (!ext) return "file";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (isAudioFile(resource)) return "voice";
  return "file";
}

/**
 * 从 Content-Type 字符串解析媒体类型。
 */
function parseContentType(ct: string): MediaType | null {
  if (!ct) return null;
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/") || ct.includes("silk") || ct.includes("amr")) return "voice";
  return null;
}

/**
 * 通过 HTTP 请求探测 URL 的 Content-Type，返回媒体类型。
 * 优先 HEAD，如果服务端不支持 HEAD（405/403/501）则 fallback 到 GET+Range。
 * 超时或失败时返回 null（调用方应 fallback 到后缀检测）。
 */
export async function detectMediaTypeByContentType(url: string): Promise<MediaType | null> {
  try {
    const resp = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000), redirect: "follow" });
    if (resp.ok) {
      const result = parseContentType(resp.headers.get("content-type")?.toLowerCase() || "");
      if (result) return result;
    }
    // HEAD 失败（405/403/501 等）或 Content-Type 无法判断，用 GET+Range 重试
    if (!resp.ok || !parseContentType(resp.headers.get("content-type")?.toLowerCase() || "")) {
      const getResp = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        signal: AbortSignal.timeout(5000),
        redirect: "follow",
      });
      const ct = getResp.headers.get("content-type")?.toLowerCase() || "";
      return parseContentType(ct);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 自动检测媒体类型（综合后缀 + Content-Type）。
 * 对本地路径直接用后缀；对 URL 先看后缀，后缀无法判断时再 HEAD 探测。
 */
export async function detectMediaType(resource: string): Promise<MediaType> {
  const byExt = detectMediaTypeByExt(resource);
  // 本地路径直接用后缀结果
  if (!/^https?:\/\//i.test(resource)) return byExt;
  // URL：后缀能判断就用后缀（避免多余网络请求）
  if (byExt !== "file") return byExt;
  // 后缀无法判断，HEAD 探测
  const byCt = await detectMediaTypeByContentType(resource);
  return byCt ?? "file";
}
