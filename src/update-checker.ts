/**
 * 后台版本检查器
 *
 * - triggerUpdateCheck(): gateway 启动时调用，后台检查 npm registry 是否有新版本
 * - getUpdateInfo(): 返回上次检查结果（供 /bot-version、/bot-help 指令使用）
 * - formatUpdateNotice(): 格式化更新提示文本
 */

import { createRequire } from "node:module";
import { execFile } from "node:child_process";

const require = createRequire(import.meta.url);

const PKG_NAME = "@tencent-connect/openclaw-qqbot";

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

  // 获取 dist-tags，同时比较 latest 和 alpha 通道
  execFile(
    "npm",
    ["view", PKG_NAME, "dist-tags", "--json"],
    { timeout: 15_000, env: { ...process.env, PATH: process.env.PATH } },
    (err, stdout, _stderr) => {
      _checking = false;
      const now = Date.now();
      if (err) {
        log?.debug?.(`[qqbot:update-checker] check failed: ${err.message}`);
        _lastInfo = { current: CURRENT_VERSION, latest: null, hasUpdate: false, checkedAt: now, error: err.message };
        return;
      }
      try {
        const tags = JSON.parse(stdout.trim());
        // 当前是 prerelease → 和 alpha 通道比；正式版 → 和 latest 通道比
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
      } catch (parseErr) {
        _lastInfo = { current: CURRENT_VERSION, latest: null, hasUpdate: false, checkedAt: now, error: String(parseErr) };
      }
    },
  );
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
  // 先比主版本号
  for (let i = 0; i < 3; i++) {
    const diff = (pa.parts[i] || 0) - (pb.parts[i] || 0);
    if (diff !== 0) return diff;
  }
  // 主版本号相同：正式版 > prerelease
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && !pb.pre) return 0;
  // 都是 prerelease：按段逐一比较（alpha.1 vs alpha.2）
  const aParts = pa.pre!.split(".");
  const bParts = pb.pre!.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aP = aParts[i] ?? "";
    const bP = bParts[i] ?? "";
    const aNum = Number(aP);
    const bNum = Number(bP);
    // 都是数字则按数字比较
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
    } else {
      // 字符串比较
      if (aP < bP) return -1;
      if (aP > bP) return 1;
    }
  }
  return 0;
}
