import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { getQQBotRuntime } from "./runtime.js";

interface LoggerLike {
  info?: (message: string) => void;
  error?: (message: string) => void;
}

type ConfigWriter = {
  writeConfigFile?: (cfg: OpenClawConfig) => Promise<void>;
};

const ownerBindInFlight = new Map<string, Promise<string[]>>();

function normalizeOwnerEntry(senderId: string): string | null {
  const normalized = senderId.trim().toUpperCase();
  if (!normalized) return null;
  return normalized.startsWith("QQBOT:") ? `qqbot:${normalized.slice("QQBOT:".length)}` : `qqbot:${normalized}`;
}

function readOwnerAllowFrom(cfg: OpenClawConfig): string[] {
  const commands = (cfg as Record<string, unknown>).commands as Record<string, unknown> | undefined;
  const ownerAllowFrom = commands?.ownerAllowFrom;
  if (!Array.isArray(ownerAllowFrom)) {
    return [];
  }
  return ownerAllowFrom
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
}

function withOwnerAllowFrom(cfg: OpenClawConfig, ownerEntry: string): OpenClawConfig {
  const current = cfg as Record<string, unknown>;
  const nextCommands = {
    ...((current.commands as Record<string, unknown> | undefined) ?? {}),
    ownerAllowFrom: [ownerEntry],
  };
  return {
    ...cfg,
    commands: nextCommands,
  };
}

function applyOwnerAllowFromInPlace(cfg: OpenClawConfig, ownerEntry: string): void {
  const current = cfg as Record<string, unknown>;
  const nextCommands = {
    ...((current.commands as Record<string, unknown> | undefined) ?? {}),
    ownerAllowFrom: [ownerEntry],
  };
  current.commands = nextCommands;
}

export async function ensureOwnerBoundForFirstC2C(params: {
  cfg: OpenClawConfig;
  accountId: string;
  senderId: string;
  log?: LoggerLike;
}): Promise<string[]> {
  const ownerEntry = normalizeOwnerEntry(params.senderId);
  if (!ownerEntry) {
    return [];
  }

  if (readOwnerAllowFrom(params.cfg).length > 0) {
    return [];
  }

  const existing = ownerBindInFlight.get(params.accountId);
  if (existing) {
    return existing;
  }

  const pending = (async () => {
    if (readOwnerAllowFrom(params.cfg).length > 0) {
      return [];
    }

    const runtime = getQQBotRuntime();
    const nextCfg = withOwnerAllowFrom(params.cfg, ownerEntry);
    let persisted = false;

    try {
      const configApi = runtime.config as ConfigWriter | undefined;
      if (typeof configApi?.writeConfigFile === "function") {
        await configApi.writeConfigFile(nextCfg);
        persisted = true;
      }
    } catch (error) {
      params.log?.error?.(
        `[qqbot:${params.accountId}] Failed to persist auto-bound owner ${ownerEntry}: ${String(error)}`
      );
    }

    // Keep the live gateway config in sync after persistence, otherwise the
    // runtime snapshot merge used by writeConfigFile can erase this change.
    applyOwnerAllowFromInPlace(params.cfg, ownerEntry);
    if (typeof runtime.setConfig === "function") {
      runtime.setConfig(nextCfg);
    }

    params.log?.info?.(
      persisted
        ? `[qqbot:${params.accountId}] Auto-bound first C2C sender as owner: ${ownerEntry}`
        : `[qqbot:${params.accountId}] Auto-bound first C2C sender as owner in runtime only: ${ownerEntry}`
    );

    return [ownerEntry];
  })().finally(() => {
    ownerBindInFlight.delete(params.accountId);
  });

  ownerBindInFlight.set(params.accountId, pending);
  return pending;
}
