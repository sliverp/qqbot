/**
 * 后台版本检查器
 *
 * - triggerUpdateCheck(): gateway 启动时调用，后台检查 npm registry 是否有新版本
 * - getUpdateInfo(): 返回上次检查结果（供 /bot-version、/bot-upgrade 指令使用）
 *
 * 使用 HTTPS 直接请求 npm registry API（不依赖 npm CLI），
 * 支持多 registry fallback：npmjs.org → npmmirror.com，解决国内网络问题。
 */

import { createRequire } from "node:module";
import https from "node:https";

const require = createRequire(import.meta.url);

const PKG_NAME = "@sliverp/qqbot";
const ENCODED_PKG = encodeURIComponent(PKG_NAME);

const REGISTRIES = [
  `https://registry.npmjs.org/${ENCODED_PKG}`,
  `https://registry.npmmirror.com/${ENCODED_PKG}`,
];

let CURRENT_VERSION = "unknown";
try {
  const pkg = require("../package.json");
  CURRENT_VERSION = pkg.version ?? "unknown";
} catch {
  // fallback
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  checkedAt: number;
  error?: string;
}

let _lastInfo: UpdateInfo = {
  current: CURRENT_VERSION,
  latest: null,
  hasUpdate: false,
  checkedAt: 0,
};

let _checking = false;

function fetchJson(url: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { Accept: "application/json" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error(`timeout fetching ${url}`)); });
  });
}

async function fetchDistTags(log?: { debug?: (msg: string) => void }): Promise<Record<string, string>> {
  for (const url of REGISTRIES) {
    try {
      const json = await fetchJson(url, 10_000);
      const tags = json["dist-tags"];
      if (tags && typeof tags === "object") return tags;
    } catch (e: any) {
      log?.debug?.(`[qqbot:update-checker] ${url} failed: ${e.message}`);
    }
  }
  throw new Error("all registries failed");
}

export function triggerUpdateCheck(log?: {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}): void {
  if (_checking) return;
  const INTERVAL_MS = 30 * 60 * 1000;
  if (_lastInfo.checkedAt > 0 && Date.now() - _lastInfo.checkedAt < INTERVAL_MS) {
    return;
  }
  _checking = true;
  log?.debug?.(`[qqbot:update-checker] checking (current: ${CURRENT_VERSION})...`);

  fetchDistTags(log).then((tags) => {
    const now = Date.now();
    const currentIsPrerelease = CURRENT_VERSION.includes("-");
    const compareTarget = currentIsPrerelease
      ? (tags.alpha || tags.latest || null)
      : (tags.latest || null);
    const hasUpdate = typeof compareTarget === "string"
      && compareTarget !== CURRENT_VERSION
      && compareVersions(compareTarget, CURRENT_VERSION) > 0;
    _lastInfo = { current: CURRENT_VERSION, latest: compareTarget, hasUpdate, checkedAt: now };
    if (hasUpdate) {
      log?.info?.(`[qqbot:update-checker] new version available: ${compareTarget} (current: ${CURRENT_VERSION})`);
    }
  }).catch((err) => {
    const now = Date.now();
    log?.debug?.(`[qqbot:update-checker] check failed: ${err.message}`);
    _lastInfo = { current: CURRENT_VERSION, latest: null, hasUpdate: false, checkedAt: now, error: err.message };
  }).finally(() => {
    _checking = false;
  });
}

export function getUpdateInfo(): UpdateInfo {
  return { ..._lastInfo };
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const clean = v.replace(/^v/, "");
    const [main, pre] = clean.split("-", 2);
    return { parts: main.split(".").map(Number), pre: pre || null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) return diff;
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && !pb.pre) return 0;
  const aParts = pa.pre!.split(".");
  const bParts = pb.pre!.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aP = aParts[i] ?? "";
    const bP = bParts[i] ?? "";
    const aNum = Number(aP);
    const bNum = Number(bP);
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
    } else {
      if (aP < bP) return -1;
      if (aP > bP) return 1;
    }
  }
  return 0;
}
