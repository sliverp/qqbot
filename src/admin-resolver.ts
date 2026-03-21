/**
 * 管理员解析器模块
 * - 管理员 openid 持久化读写
 * - 升级问候目标读写
 * - 启动问候语发送
 */

import path from "node:path";
import * as fs from "node:fs";
import { getQQBotDataDir } from "./utils/platform.js";
import { listKnownUsers } from "./known-users.js";
import { getAccessToken, sendProactiveC2CMessage } from "./api.js";
import { getStartupGreetingPlan, markStartupGreetingSent, markStartupGreetingFailed } from "./startup-greeting.js";

// ---- 类型 ----

export interface AdminResolverContext {
  accountId: string;
  appId: string;
  clientSecret: string;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
}

// ---- 文件路径 ----

function getAdminMarkerFile(accountId: string, appId?: string): string {
  if (appId) {
    const safeAccountId = accountId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeAppId = appId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(getQQBotDataDir("data"), `admin-${safeAccountId}-${safeAppId}.json`);
  }
  return path.join(getQQBotDataDir("data"), `admin-${accountId}.json`);
}

function getUpgradeGreetingTargetFile(accountId: string, appId: string): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeAppId = appId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(getQQBotDataDir("data"), `upgrade-greeting-target-${safeAccountId}-${safeAppId}.json`);
}

// ---- 管理员 openid 持久化 ----

export function loadAdminOpenId(accountId: string, appId?: string): string | undefined {
  try {
    // 优先读带 appId 的文件（精确匹配）
    if (appId) {
      const file = getAdminMarkerFile(accountId, appId);
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        if (data.openid) return data.openid;
      }
    }
    // fallback：兼容旧格式（无 appId 的文件）
    const legacyFile = getAdminMarkerFile(accountId);
    if (fs.existsSync(legacyFile)) {
      const data = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
      if (data.openid) return data.openid;
    }
  } catch { /* 文件损坏视为无 */ }
  return undefined;
}

export function saveAdminOpenId(accountId: string, openid: string, appId?: string): void {
  try {
    const payload = { openid, appId, savedAt: new Date().toISOString() };
    // 始终写入带 appId 的文件
    if (appId) {
      fs.writeFileSync(getAdminMarkerFile(accountId, appId), JSON.stringify(payload));
    }
    // 同时写旧格式兼容文件
    fs.writeFileSync(getAdminMarkerFile(accountId), JSON.stringify(payload));
  } catch { /* ignore */ }
}

// ---- 升级问候目标 ----

export function loadUpgradeGreetingTargetOpenId(accountId: string, appId: string): string | undefined {
  try {
    const file = getUpgradeGreetingTargetFile(accountId, appId);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as { accountId?: string; appId?: string; openid?: string };
      if (!data.openid) return undefined;
      if (data.appId && data.appId !== appId) return undefined;
      if (data.accountId && data.accountId !== accountId) return undefined;
      return data.openid;
    }
  } catch { /* 文件损坏视为无 */ }
  return undefined;
}

export function clearUpgradeGreetingTargetOpenId(accountId: string, appId: string): void {
  try {
    const file = getUpgradeGreetingTargetFile(accountId, appId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch { /* ignore */ }
}

// ---- 解析管理员 ----

/**
 * 解析管理员 openid：
 * 1. 优先读持久化文件（按 accountId+appId 精确匹配）
 * 2. fallback 取第一个私聊用户，并写入文件锁定
 */
export function resolveAdminOpenId(ctx: Pick<AdminResolverContext, "accountId" | "appId" | "log">): string | undefined {
  const saved = loadAdminOpenId(ctx.accountId, ctx.appId);
  if (saved) return saved;
  const first = listKnownUsers({ accountId: ctx.accountId, type: "c2c", sortBy: "firstSeenAt", sortOrder: "asc", limit: 1 })[0]?.openid;
  if (first) {
    saveAdminOpenId(ctx.accountId, first, ctx.appId);
    ctx.log?.info(`[qqbot:${ctx.accountId}] Auto-detected admin openid: ${first} (persisted, appId=${ctx.appId})`);
  }
  return first;
}

// ---- 启动问候语 ----

/** 异步发送启动问候语（仅发给管理员） */
export function sendStartupGreetings(ctx: AdminResolverContext, trigger: "READY" | "RESUMED"): void {
  (async () => {
    const plan = getStartupGreetingPlan();
    if (!plan.shouldSend || !plan.greeting) {
      ctx.log?.info(`[qqbot:${ctx.accountId}] Skipping startup greeting (${plan.reason ?? "debounced"}, trigger=${trigger})`);
      return;
    }

    const upgradeTargetOpenId = loadUpgradeGreetingTargetOpenId(ctx.accountId, ctx.appId);
    const targetOpenId = upgradeTargetOpenId || resolveAdminOpenId(ctx);
    if (!targetOpenId) {
      markStartupGreetingFailed(plan.version, "no-admin");
      ctx.log?.info(`[qqbot:${ctx.accountId}] Skipping startup greeting (no admin or known user)`);
      return;
    }

    try {
      const receiverType = upgradeTargetOpenId ? "upgrade-requester" : "admin";
      ctx.log?.info(`[qqbot:${ctx.accountId}] Sending startup greeting to ${receiverType} (trigger=${trigger}): "${plan.greeting}"`);
      const token = await getAccessToken(ctx.appId, ctx.clientSecret);
      const GREETING_TIMEOUT_MS = 10_000;
      await Promise.race([
        sendProactiveC2CMessage(token, targetOpenId, plan.greeting),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Startup greeting send timeout (10s)")), GREETING_TIMEOUT_MS)),
      ]);
      markStartupGreetingSent(plan.version);
      if (upgradeTargetOpenId) {
        clearUpgradeGreetingTargetOpenId(ctx.accountId, ctx.appId);
      }
      ctx.log?.info(`[qqbot:${ctx.accountId}] Sent startup greeting to ${receiverType}: ${targetOpenId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markStartupGreetingFailed(plan.version, message);
      ctx.log?.error(`[qqbot:${ctx.accountId}] Failed to send startup greeting: ${message}`);
    }
  })();
}
