import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { ResolvedQQBotAccount } from "./types.js";

let runtime: PluginRuntime | null = null;
let currentAccount: ResolvedQQBotAccount | null = null;

export function setQQBotRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getQQBotRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("QQBot runtime not initialized");
  }
  return runtime;
}

/**
 * 设置当前已解析的 QQBot 账户配置
 * 在 channel.startAccount 时调用，存储预先解析好的 account 对象
 */
export function setCurrentQQBotAccount(account: ResolvedQQBotAccount) {
  currentAccount = account;
}

/**
 * 获取当前已解析的 QQBot 账户配置
 * 工具函数可以直接调用此方法获取已解析好的 account
 */
export function getCurrentQQBotAccount(): ResolvedQQBotAccount | null {
  return currentAccount;
}
