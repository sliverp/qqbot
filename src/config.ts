import type { ResolvedQQBotAccount, QQBotAccountConfig } from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

interface MoltbotConfig {
  channels?: {
    qqbot?: QQBotChannelConfig;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface QQBotChannelConfig extends QQBotAccountConfig {
  accounts?: Record<string, QQBotAccountConfig>;
}

/**
 * 列出所有 QQBot 账户 ID
 */
export function listQQBotAccountIds(cfg: MoltbotConfig): string[] {
  const ids = new Set<string>();
  const qqbot = cfg.channels?.qqbot;

  if (qqbot?.appId) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (qqbot?.accounts) {
    for (const accountId of Object.keys(qqbot.accounts)) {
      if (qqbot.accounts[accountId]?.appId) {
        ids.add(accountId);
      }
    }
  }

  return Array.from(ids);
}

/**
 * 解析 QQBot 账户配置
 */
export function resolveQQBotAccount(
  cfg: MoltbotConfig,
  accountId?: string | null
): ResolvedQQBotAccount {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const qqbot = cfg.channels?.qqbot;

  // 基础配置
  let accountConfig: QQBotAccountConfig = {};
  let appId = "";
  let clientSecret = "";
  let secretSource: "config" | "file" | "env" | "none" = "none";

  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    // 默认账户从顶层读取
    accountConfig = {
      enabled: qqbot?.enabled,
      name: qqbot?.name,
      appId: qqbot?.appId,
      clientSecret: qqbot?.clientSecret,
      clientSecretFile: qqbot?.clientSecretFile,
      dmPolicy: qqbot?.dmPolicy,
      allowFrom: qqbot?.allowFrom,
      systemPrompt: qqbot?.systemPrompt,
      httpProxy: qqbot?.httpProxy,
    };
    appId = qqbot?.appId ?? "";
  } else {
    // 命名账户从 accounts 读取
    const account = qqbot?.accounts?.[resolvedAccountId];
    accountConfig = account ?? {};
    appId = account?.appId ?? "";
  }

  // 解析 clientSecret
  if (accountConfig.clientSecret) {
    clientSecret = accountConfig.clientSecret;
    secretSource = "config";
  } else if (accountConfig.clientSecretFile) {
    // 从文件读取（运行时处理）
    secretSource = "file";
  } else if (process.env.QQBOT_CLIENT_SECRET && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    clientSecret = process.env.QQBOT_CLIENT_SECRET;
    secretSource = "env";
  }

  // AppId 也可以从环境变量读取
  if (!appId && process.env.QQBOT_APP_ID && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    appId = process.env.QQBOT_APP_ID;
  }

  // 解析 HTTP 代理：配置 > 环境变量
  const httpProxy = accountConfig.httpProxy
    || process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || process.env.https_proxy
    || process.env.http_proxy
    || undefined;

  return {
    accountId: resolvedAccountId,
    name: accountConfig.name,
    enabled: accountConfig.enabled !== false,
    appId,
    clientSecret,
    secretSource,
    systemPrompt: accountConfig.systemPrompt,
    httpProxy,
    config: accountConfig,
  };
}

/**
 * 应用账户配置
 */
export function applyQQBotAccountConfig(
  cfg: MoltbotConfig,
  accountId: string,
  input: { appId?: string; clientSecret?: string; clientSecretFile?: string; name?: string }
): MoltbotConfig {
  const next = { ...cfg };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    next.channels = {
      ...next.channels,
      qqbot: {
        ...next.channels?.qqbot,
        enabled: true,
        ...(input.appId ? { appId: input.appId } : {}),
        ...(input.clientSecret
          ? { clientSecret: input.clientSecret }
          : input.clientSecretFile
            ? { clientSecretFile: input.clientSecretFile }
            : {}),
        ...(input.name ? { name: input.name } : {}),
      },
    };
  } else {
    next.channels = {
      ...next.channels,
      qqbot: {
        ...next.channels?.qqbot,
        enabled: true,
        accounts: {
          ...(next.channels?.qqbot as QQBotChannelConfig)?.accounts,
          [accountId]: {
            ...(next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId],
            enabled: true,
            ...(input.appId ? { appId: input.appId } : {}),
            ...(input.clientSecret
              ? { clientSecret: input.clientSecret }
              : input.clientSecretFile
                ? { clientSecretFile: input.clientSecretFile }
                : {}),
            ...(input.name ? { name: input.name } : {}),
          },
        },
      },
    };
  }

  return next;
}
