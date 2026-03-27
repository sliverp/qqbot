import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { qqbotPlugin } from "./src/channel.js";
import { setQQBotRuntime } from "./src/runtime.js";
import { setOpenClawStateDir } from "./src/utils/platform.js";
import { registerChannelTool } from "./src/tools/channel.js";
import { registerRemindTool } from "./src/tools/remind.js";

const plugin = {
  id: "openclaw-qqbot",
  name: "QQ Bot",
  description: "QQ Bot channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // 首先设置 OpenClaw 状态目录，确保后续所有数据存储使用正确的路径
    // 这解决了开发环境和生产环境数据隔离的问题
    // 注意：runtime.state 在较新版本的 openclaw 中才可用，使用类型断言兼容旧版本
    const runtimeState = (api.runtime as { state?: { resolveStateDir?: () => string } }).state;
    if (runtimeState?.resolveStateDir) {
      const stateDir = runtimeState.resolveStateDir();
      setOpenClawStateDir(stateDir);
    }

    setQQBotRuntime(api.runtime);
    api.registerChannel({ plugin: qqbotPlugin as any });
    registerChannelTool(api);
    registerRemindTool(api);
  },
};

export default plugin;

export { qqbotPlugin } from "./src/channel.js";
export { setQQBotRuntime, getQQBotRuntime } from "./src/runtime.js";
export { setOpenClawStateDir } from "./src/utils/platform.js";
export { qqbotOnboardingAdapter } from "./src/onboarding.js";
export * from "./src/types.js";
export * from "./src/api.js";
export * from "./src/config.js";
export * from "./src/gateway.js";
export * from "./src/outbound.js";
