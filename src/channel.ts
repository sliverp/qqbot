import {
  type ChannelPlugin,
  type OpenClawConfig,
  applyAccountNameToChannelSection,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk";

import type { ResolvedQQBotAccount } from "./types.js";
import { DEFAULT_ACCOUNT_ID, listQQBotAccountIds, resolveQQBotAccount, applyQQBotAccountConfig, resolveDefaultQQBotAccountId } from "./config.js";
import { sendText, sendMedia } from "./outbound.js";
import { startGateway } from "./gateway.js";
import { qqbotOnboardingAdapter } from "./onboarding.js";
import { getQQBotRuntime } from "./runtime.js";

/**
 * 简单的文本分块函数
 * 用于预先分块长文本
 */
function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    
    // 尝试在换行处分割
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0 || splitAt < limit * 0.5) {
      // 没找到合适的换行，尝试在空格处分割
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt <= 0 || splitAt < limit * 0.5) {
      // 还是没找到，强制在 limit 处分割
      splitAt = limit;
    }
    
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  
  return chunks;
}

export const qqbotPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  id: "qqbot",
  meta: {
    id: "qqbot",
    label: "QQ Bot",
    selectionLabel: "QQ Bot",
    docsPath: "/docs/channels/qqbot",
    blurb: "Connect to QQ via official QQ Bot API",
    order: 50,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    /**
     * blockStreaming: true 表示该 Channel 支持块流式
     * 框架会收集流式响应，然后通过 deliver 回调发送
     */
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.qqbot"] },
  // CLI onboarding wizard
  onboarding: qqbotOnboardingAdapter,
  // messaging 定义在下方（合并了两处定义）
  config: {
    listAccountIds: (cfg) => listQQBotAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveQQBotAccount(cfg, accountId),
    defaultAccountId: (cfg) => resolveDefaultQQBotAccountId(cfg),
    // 新增：设置账户启用状态
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "qqbot",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    // 新增：删除账户
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "qqbot",
        accountId,
        clearBaseFields: ["appId", "clientSecret", "clientSecretFile", "name"],
      }),
    isConfigured: (account) => Boolean(account?.appId && account?.clientSecret),
    describeAccount: (account) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.appId && account?.clientSecret),
      tokenSource: account?.secretSource,
    }),
    // 关键：解析 allowFrom 配置，用于命令授权
    resolveAllowFrom: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      const allowFrom = account.config?.allowFrom ?? [];
      console.log(`[qqbot] resolveAllowFrom: accountId=${accountId}, allowFrom=${JSON.stringify(allowFrom)}`);
      return allowFrom.map((entry: string | number) => String(entry));
    },
    // 格式化 allowFrom 条目（移除 qqbot: 前缀，统一大写）
    formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
      allowFrom
        .map((entry: string | number) => String(entry).trim())
        .filter(Boolean)
        .map((entry: string) => entry.replace(/^qqbot:/i, ""))
        .map((entry: string) => entry.toUpperCase()), // QQ openid 是大写的
  },
  setup: {
    // 新增：规范化账户 ID
    resolveAccountId: ({ accountId }) => accountId?.trim().toLowerCase() || DEFAULT_ACCOUNT_ID,
    // 新增：应用账户名称
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "qqbot",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.token && !input.tokenFile && !input.useEnv) {
        return "QQBot requires --token (format: appId:clientSecret) or --use-env";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      let appId = "";
      let clientSecret = "";

      if (input.token) {
        const parts = input.token.split(":");
        if (parts.length === 2) {
          appId = parts[0];
          clientSecret = parts[1];
        }
      }

      return applyQQBotAccountConfig(cfg, accountId, {
        appId,
        clientSecret,
        clientSecretFile: input.tokenFile,
        name: input.name,
      });
    },
  },
  // Messaging 配置：用于解析目标地址
  messaging: {
    /**
     * 规范化目标地址
     * 支持以下格式：
     * - qqbot:c2c:openid -> 私聊
     * - qqbot:group:groupid -> 群聊
     * - qqbot:channel:channelid -> 频道
     * - c2c:openid -> 私聊
     * - group:groupid -> 群聊
     * - channel:channelid -> 频道
     * - 纯 openid（32位十六进制）-> 私聊
     */
    normalizeTarget: (target: string) => {
      // 去掉 qqbot: 前缀（如果有）
      const id = target.replace(/^qqbot:/i, "");
      
      // 检查是否是已知格式
      if (id.startsWith("c2c:") || id.startsWith("group:") || id.startsWith("channel:")) {
        return { ok: true, to: `qqbot:${id}` };
      }
      
      // 检查是否是纯 openid（32位十六进制，带连字符）
      // QQ Bot OpenID 格式类似: 207A5B8339D01F6582911C014668B77B
      const openIdPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
      if (openIdPattern.test(id)) {
        return { ok: true, to: `qqbot:c2c:${id}` };
      }
      
      // 不认识的格式
      return { 
        ok: false, 
        error: `Invalid QQ Bot target format: "${target}". Expected: qqbot:c2c:openid, qqbot:group:groupid, or openid (UUID format)` 
      };
    },
    /**
     * 目标解析器配置
     * 用于判断一个目标 ID 是否看起来像 QQ Bot 的格式
     */
    targetResolver: {
      /**
       * 判断目标 ID 是否可能是 QQ Bot 格式
       * 支持以下格式：
       * - qqbot:c2c:xxx
       * - qqbot:group:xxx  
       * - qqbot:channel:xxx
       * - c2c:xxx
       * - group:xxx
       * - channel:xxx
       * - UUID 格式的 openid
       */
      looksLikeId: (id: string): boolean => {
        // 带 qqbot: 前缀的格式
        if (/^qqbot:(c2c|group|channel):/i.test(id)) {
          return true;
        }
        // 不带前缀但有类型标识
        if (/^(c2c|group|channel):/i.test(id)) {
          return true;
        }
        // UUID 格式的 openid（QQ Bot 的用户/群 ID 格式）
        const openIdPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
        return openIdPattern.test(id);
      },
      hint: "QQ Bot 目标格式: qqbot:c2c:openid (私聊) 或 qqbot:group:groupid (群聊)",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: chunkText,
    chunkerMode: "markdown",
    textChunkLimit: 2000,
    sendText: async ({ to, text, accountId, replyToId, cfg }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      const result = await sendText({ to, text, accountId, replyToId, account });
      return {
        channel: "qqbot",
        messageId: result.messageId,
        error: result.error ? new Error(result.error) : undefined,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, cfg }) => {
      const account = resolveQQBotAccount(cfg, accountId);
      const result = await sendMedia({ to, text: text ?? "", mediaUrl: mediaUrl ?? "", accountId, replyToId, account });
      return {
        channel: "qqbot",
        messageId: result.messageId,
        error: result.error ? new Error(result.error) : undefined,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, log, cfg } = ctx;

      log?.info(`[qqbot:${account.accountId}] Starting gateway`);

      await startGateway({
        account,
        abortSignal,
        cfg,
        log,
        onReady: () => {
          log?.info(`[qqbot:${account.accountId}] Gateway ready`);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: true,
            connected: true,
            lastConnectedAt: Date.now(),
          });
        },
        onError: (error) => {
          log?.error(`[qqbot:${account.accountId}] Gateway error: ${error.message}`);
          ctx.setStatus({
            ...ctx.getStatus(),
            lastError: error.message,
          });
        },
      });
    },
    // 新增：登出账户（清除配置中的凭证）
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const nextQQBot = cfg.channels?.qqbot ? { ...cfg.channels.qqbot } : undefined;
      let cleared = false;
      let changed = false;

      if (nextQQBot) {
        const qqbot = nextQQBot as Record<string, unknown>;
        if (accountId === DEFAULT_ACCOUNT_ID && qqbot.clientSecret) {
          delete qqbot.clientSecret;
          cleared = true;
          changed = true;
        }
        const accounts = qqbot.accounts as Record<string, Record<string, unknown>> | undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId] as Record<string, unknown> | undefined;
          if (entry && "clientSecret" in entry) {
            delete entry.clientSecret;
            cleared = true;
            changed = true;
          }
          if (entry && Object.keys(entry).length === 0) {
            delete accounts[accountId];
            changed = true;
          }
        }
      }

      if (changed && nextQQBot) {
        nextCfg.channels = { ...nextCfg.channels, qqbot: nextQQBot };
        const runtime = getQQBotRuntime();
        const configApi = runtime.config as { writeConfigFile: (cfg: OpenClawConfig) => Promise<void> };
        await configApi.writeConfigFile(nextCfg);
      }

      const resolved = resolveQQBotAccount(changed ? nextCfg : cfg, accountId);
      const loggedOut = resolved.secretSource === "none";
      const envToken = Boolean(process.env.QQBOT_CLIENT_SECRET);

      return { ok: true, cleared, envToken, loggedOut };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    // 新增：构建通道摘要
    buildChannelSummary: ({ snapshot }: { snapshot: Record<string, unknown> }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }: { account?: ResolvedQQBotAccount; runtime?: Record<string, unknown> }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.appId && account?.clientSecret),
      tokenSource: account?.secretSource,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
};
