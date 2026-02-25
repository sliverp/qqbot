/**
 * 代理支持工具函数
 *
 * 提供 SOCKS5/HTTP 代理的 Agent 创建和缓存
 */

import { SocksProxyAgent } from "socks-proxy-agent";
import type { Agent } from "undici";

// 全局代理 Agent 缓存（单例）
let globalProxyAgent: SocksProxyAgent | null = null;
let globalUndiciDispatcher: Agent | null = null;
// 记录当前缓存的代理 URL，用于检测代理配置变更
let cachedProxyUrl: string | null = null;

/**
 * 获取代理 Agent（单例模式）
 *
 * @param proxyUrl 代理 URL，例如：socks5://100.67.244.78:1080 或 socks5h://100.67.244.78:1080
 * @returns 代理 Agent 实例，如果未提供代理 URL 则返回 null
 */
export function getProxyAgent(proxyUrl?: string): SocksProxyAgent | null {
  if (!proxyUrl) {
    console.log(`[qqbot-proxy] No proxy URL provided, returning null`);
    return null;
  }

  // SocksProxyAgent 支持 socks5:// 和 socks5h:// 前缀
  // socks5h:// 表示 DNS 也走代理（推荐）
  const normalizedUrl = proxyUrl;
  console.log(`[qqbot-proxy] getProxyAgent called with: ${proxyUrl}, cachedProxyUrl: ${cachedProxyUrl}, hasGlobalAgent: ${!!globalProxyAgent}`);

  // 如果已有缓存且代理 URL 相同，直接返回
  if (globalProxyAgent && cachedProxyUrl === normalizedUrl) {
    console.log(`[qqbot-proxy] Returning cached proxy agent`);
    return globalProxyAgent;
  }

  // 如果 URL 不同，清除旧缓存
  if (globalProxyAgent && cachedProxyUrl !== normalizedUrl) {
    console.log(`[qqbot-proxy] Proxy URL changed from ${cachedProxyUrl} to ${normalizedUrl}, recreating agent`);
  }

  try {
    globalProxyAgent = new SocksProxyAgent(normalizedUrl);
    cachedProxyUrl = normalizedUrl;
    console.log(`[qqbot-proxy] ✅ Proxy agent created successfully: ${proxyUrl}`);
    return globalProxyAgent;
  } catch (err) {
    console.error(`[qqbot-proxy] ❌ Failed to create proxy agent: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 获取 undici Dispatcher（用于 fetch 请求）
 * 使用 SocksProxyAgent 的 options 作为 connect 配置
 */
export async function getUndiciDispatcher(proxyUrl?: string): Promise<Agent | null> {
  if (!proxyUrl) {
    return null;
  }

  // socks5h:// 表示 DNS 也走代理，SocksProxyAgent 支持这个前缀
  // 不要转换，直接使用原始 URL
  const normalizedUrl = proxyUrl;

  // 如果已有缓存且代理 URL 相同，直接返回
  if (globalUndiciDispatcher && cachedProxyUrl === normalizedUrl) {
    return globalUndiciDispatcher;
  }

  const socksAgent = getProxyAgent(normalizedUrl);
  if (!socksAgent) {
    return null;
  }

  try {
    const { Agent } = await import("undici");
    // 使用 SocksProxyAgent 的 options 作为 undici 的 connect 配置
    // socksAgent.options 包含 { host, port, type } 等信息
    globalUndiciDispatcher = new Agent({
      connect: socksAgent.options,
    });
    console.log(`[qqbot-proxy] Undici dispatcher created using socksAgent.options`);
    return globalUndiciDispatcher;
  } catch (err) {
    console.error(`[qqbot-proxy] Failed to create undici dispatcher: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * 清除代理 Agent 缓存
 *
 * 当代理配置变更时调用此函数
 */
export function clearProxyAgent(): void {
  globalProxyAgent = null;
  globalUndiciDispatcher = null;
  cachedProxyUrl = null;
}
