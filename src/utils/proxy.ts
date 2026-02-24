/**
 * 代理支持工具函数
 *
 * 提供 SOCKS5/HTTP 代理的 Agent 创建和缓存
 */

import { SocksProxyAgent } from "socks-proxy-agent";

// 全局代理 Agent 缓存（单例）
let globalProxyAgent: SocksProxyAgent | null = null;

/**
 * 获取代理 Agent（单例模式）
 *
 * @param proxyUrl 代理 URL，例如：socks5://100.67.244.78:1080
 * @returns 代理 Agent 实例，如果未提供代理 URL 则返回 null
 */
export function getProxyAgent(proxyUrl?: string): SocksProxyAgent | null {
  if (!proxyUrl) {
    return null;
  }

  // 如果已有缓存且代理 URL 相同，直接返回
  if (globalProxyAgent) {
    return globalProxyAgent;
  }

  try {
    globalProxyAgent = new SocksProxyAgent(proxyUrl);
    console.log(`[qqbot-proxy] Proxy agent created: ${proxyUrl}`);
    return globalProxyAgent;
  } catch (err) {
    console.error(`[qqbot-proxy] Failed to create proxy agent: ${err instanceof Error ? err.message : String(err)}`);
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
}
