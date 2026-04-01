import type { PluginRuntime } from "openclaw/plugin-sdk";
import { setOpenClawVersion } from "./api.js";

let runtime: PluginRuntime | null = null;

export function setQQBotRuntime(next: PluginRuntime) {
  runtime = next;
  // 将框架版本注入 User-Agent（runtime 注入后才能拿到准确版本）
  setOpenClawVersion(next.version);
}

export function getQQBotRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("QQBot runtime not initialized");
  }
  return runtime;
}
