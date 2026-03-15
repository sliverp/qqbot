import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { DEFAULT_ACCOUNT_ID, resolveQQBotAccount } from "./config.js";
import { getQQBotRuntime } from "./runtime.js";
import type { ResolvedQQBotAccount } from "./types.js";

type WriteConfigApi = {
  writeConfigFile: (cfg: OpenClawConfig) => Promise<void>;
};

type QQBotChannelConfig = {
  allowFrom?: Array<string | number>;
  accounts?: Record<string, QQBotAccountEntry | undefined>;
  [key: string]: unknown;
};

type QQBotAccountEntry = {
  allowFrom?: Array<string | number>;
  [key: string]: unknown;
};

type CommandsConfig = {
  ownerAllowFrom?: Array<string | number>;
  [key: string]: unknown;
};

function normalizeOpenID(openid: string): string {
  return openid.trim().toUpperCase();
}

function hasConfiguredList(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => String(entry ?? "").trim().length > 0);
}

function cloneQQBotConfig(cfg: OpenClawConfig): QQBotChannelConfig {
  const existing = (cfg.channels?.qqbot as QQBotChannelConfig | undefined) ?? {};
  return {
    ...existing,
    accounts: existing.accounts ? { ...existing.accounts } : existing.accounts,
  };
}

export function buildInitialQQBotAllowlistConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  openid: string;
}): OpenClawConfig | null {
  const normalizedOpenID = normalizeOpenID(params.openid);
  if (!normalizedOpenID) {
    return null;
  }

  const qqbot = (params.cfg.channels?.qqbot as QQBotChannelConfig | undefined) ?? {};
  const commands = (params.cfg.commands as CommandsConfig | undefined) ?? {};

  const existingAllowFrom =
    params.accountId === DEFAULT_ACCOUNT_ID
      ? qqbot.allowFrom
      : qqbot.accounts?.[params.accountId]?.allowFrom;
  const existingOwnerAllowFrom = commands.ownerAllowFrom;

  if (hasConfiguredList(existingAllowFrom) || hasConfiguredList(existingOwnerAllowFrom)) {
    return null;
  }

  const nextCfg: OpenClawConfig = structuredClone(params.cfg ?? {});
  const nextQQBot = cloneQQBotConfig(nextCfg);
  const ownerEntry = `qqbot:${normalizedOpenID}`;

  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    nextQQBot.allowFrom = [normalizedOpenID];
  } else {
    const accountEntry = {
      ...(nextQQBot.accounts?.[params.accountId] ?? {}),
      allowFrom: [normalizedOpenID],
    };
    nextQQBot.accounts = {
      ...(nextQQBot.accounts ?? {}),
      [params.accountId]: accountEntry,
    };
  }

  nextCfg.channels = {
    ...(nextCfg.channels ?? {}),
    qqbot: nextQQBot,
  };
  nextCfg.commands = {
    ...((nextCfg.commands as CommandsConfig | undefined) ?? {}),
    ownerAllowFrom: [ownerEntry],
  };

  return nextCfg;
}

export async function maybePersistInitialQQBotAllowlist(params: {
  cfg: OpenClawConfig;
  account: ResolvedQQBotAccount;
  openid: string;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<{ cfg: OpenClawConfig; account: ResolvedQQBotAccount; changed: boolean }> {
  const nextCfg = buildInitialQQBotAllowlistConfig({
    cfg: params.cfg,
    accountId: params.account.accountId,
    openid: params.openid,
  });
  if (!nextCfg) {
    return {
      cfg: params.cfg,
      account: params.account,
      changed: false,
    };
  }

  const runtime = getQQBotRuntime();
  const configApi = runtime.config as WriteConfigApi;
  await configApi.writeConfigFile(nextCfg);
  runtime.setConfig(nextCfg);

  const nextAccount = resolveQQBotAccount(nextCfg, params.account.accountId);
  params.log?.info?.(
    `[qqbot:${params.account.accountId}] Seeded initial allowFrom/ownerAllowFrom for ${normalizeOpenID(params.openid)}`,
  );

  return {
    cfg: nextCfg,
    account: nextAccount,
    changed: true,
  };
}
