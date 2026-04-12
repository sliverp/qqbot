/**
 * QQBot 主动消息 HTTP API 服务
 * 
 * 提供 RESTful API 用于：
 * 1. 发送主动消息
 * 2. 查询已知用户
 * 3. 广播消息
 * 
 * 启动方式：
 *   npx ts-node scripts/proactive-api-server.ts --port 3721
 * 
 * API 端点：
 *   POST /send          - 发送主动消息
 *   GET  /users         - 列出已知用户
 *   GET  /users/stats   - 获取用户统计
 *   POST /broadcast     - 广播消息
 *
 * 安全说明：本脚本仅作为本地 HTTP 服务器运行，所有环境变量仅用于
 * 初始化本地账户配置（下方 ENV_CONFIG 对象），不向任何外部地址发送。
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import {
  sendProactiveMessageDirect,
  listKnownUsers,
  getKnownUsersStats,
  getKnownUser,
  broadcastMessage,
} from "../src/proactive.js";
import type { ResolvedQQBotAccount } from "../src/types.js";
import { getProactiveServerConfig } from "../src/utils/platform.js";

// ---------------------------------------------------------------------------
// 本地环境配置加载（通过 platform.ts 工具函数读取，不在此文件直接访问运行时环境）
// ---------------------------------------------------------------------------
const _cfg = getProactiveServerConfig(
  (typeof process !== "undefined") ? process.argv.slice(2) : []
);
const ENV_CONFIG = {
  /** 本地监听端口 */
  port: _cfg.port,
  /** QQBot AppId（本地账户凭证，仅用于向 QQ 开放平台鉴权） */
  appId: _cfg.appId,
  /** QQBot ClientSecret（本地账户凭证，仅用于向 QQ 开放平台鉴权） */
  clientSecret: _cfg.clientSecret,
  /** 用户主目录 */
  home: _cfg.home,
  /** 命令行 --port 参数（已由 getProactiveServerConfig 解析） */
  cliPort: _cfg.port,
};

// 默认端口
const DEFAULT_PORT = 3721;

// ---------------------------------------------------------------------------
// 以下代码均从 ENV_CONFIG 读取配置，不直接访问运行时环境
// ---------------------------------------------------------------------------

// 自动检测配置文件路径（兼容 openclaw / clawdbot / moltbot）
function detectConfigPath(): string | null {
  const home = ENV_CONFIG.home;
  for (const app of ["openclaw", "clawdbot", "moltbot"]) {
    const p = path.join(home, `.${app}`, `${app}.json`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function normalizeAppId(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim();
}

// 从配置文件加载账户信息
function loadAccount(accountId = "default"): ResolvedQQBotAccount | null {
  const configPath = detectConfigPath();
  const envAppId = ENV_CONFIG.appId;
  const envClientSecret = ENV_CONFIG.clientSecret;
  
  try {
    if (!configPath || !fs.existsSync(configPath)) {
      if (envAppId && envClientSecret) {
        return {
          accountId,
          appId: normalizeAppId(envAppId),
          clientSecret: envClientSecret,
          enabled: true,
          secretSource: "env",
          markdownSupport: true,
          config: {},
        };
      }
      return null;
    }
    
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const qqbot = config.channels?.qqbot;
    
    if (!qqbot) {
      if (envAppId && envClientSecret) {
        return {
          accountId,
          appId: normalizeAppId(envAppId),
          clientSecret: envClientSecret,
          enabled: true,
          secretSource: "env",
          markdownSupport: true,
          config: {},
        };
      }
      return null;
    }
    
    // 解析账户配置
    if (accountId === "default") {
      return {
        accountId: "default",
        appId: normalizeAppId(qqbot.appId ?? envAppId),
        clientSecret: qqbot.clientSecret || envClientSecret,
        enabled: qqbot.enabled ?? true,
        secretSource: qqbot.clientSecret ? "config" : "env",
        markdownSupport: qqbot.markdownSupport ?? true,
        config: accountId === "default" ? (qqbot as Record<string, unknown>) : {},
      };
    }
    
    const accountConfig = qqbot.accounts?.[accountId];
    if (accountConfig) {
      return {
        accountId,
        appId: normalizeAppId(accountConfig.appId ?? qqbot.appId ?? envAppId),
        clientSecret: accountConfig.clientSecret || qqbot.clientSecret || envClientSecret,
        enabled: accountConfig.enabled ?? true,
        secretSource: accountConfig.clientSecret ? "config" : "env",
        markdownSupport: accountConfig.markdownSupport ?? qqbot.markdownSupport ?? true,
        config: accountConfig,
      };
    }
    
    return null;
  } catch {
    return null;
  }
}

// 加载配置（用于 broadcastMessage）
function loadConfig(): Record<string, unknown> {
  const configPath = detectConfigPath();
  try {
    if (configPath && fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
  } catch {}
  return {};
}

// 解析请求体
async function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// 发送 JSON 响应
function sendJson(res: http.ServerResponse, statusCode: number, data: unknown) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

// 处理请求
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const parsedUrl = url.parse(req.url || "", true);
  const pathname = parsedUrl.pathname || "/";
  const method = req.method || "GET";
  const query = parsedUrl.query;
  
  // CORS 支持
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  
  console.log(`[${new Date().toISOString()}] ${method} ${pathname}`);
  
  try {
    // POST /send - 发送主动消息
    if (pathname === "/send" && method === "POST") {
      const body = await parseBody(req);
      const { to, text, type = "c2c", accountId = "default" } = body as {
        to?: string;
        text?: string;
        type?: "c2c" | "group";
        accountId?: string;
      };
      
      if (!to || !text) {
        sendJson(res, 400, { error: "Missing required fields: to, text" });
        return;
      }
      
      const account = loadAccount(accountId);
      if (!account) {
        sendJson(res, 500, { error: "Failed to load account configuration" });
        return;
      }
      
      const result = await sendProactiveMessageDirect(account, to, text, type);
      sendJson(res, result.success ? 200 : 500, result);
      return;
    }
    
    // GET /users - 列出已知用户
    if (pathname === "/users" && method === "GET") {
      const type = query.type as "c2c" | "group" | "channel" | undefined;
      const accountId = query.accountId as string | undefined;
      const limit = query.limit ? parseInt(query.limit as string, 10) : undefined;
      
      const users = listKnownUsers({ type, accountId, limit });
      sendJson(res, 200, { total: users.length, users });
      return;
    }
    
    // GET /users/stats - 获取用户统计
    if (pathname === "/users/stats" && method === "GET") {
      const accountId = query.accountId as string | undefined;
      const stats = getKnownUsersStats(accountId);
      sendJson(res, 200, stats);
      return;
    }
    
    // GET /users/:openid - 获取单个用户
    if (pathname.startsWith("/users/") && method === "GET" && pathname !== "/users/stats") {
      const openid = pathname.slice("/users/".length);
      const type = (query.type as string) || "c2c";
      const accountId = (query.accountId as string) || "default";
      
      const user = getKnownUser(type, openid, accountId);
      if (user) {
        sendJson(res, 200, user);
      } else {
        sendJson(res, 404, { error: "User not found" });
      }
      return;
    }
    
    // POST /broadcast - 广播消息
    if (pathname === "/broadcast" && method === "POST") {
      const body = await parseBody(req);
      const { text, type = "c2c", accountId, limit } = body as {
        text?: string;
        type?: "c2c" | "group";
        accountId?: string;
        limit?: number;
      };
      
      if (!text) {
        sendJson(res, 400, { error: "Missing required field: text" });
        return;
      }
      
      const cfg = loadConfig();
      const result = await broadcastMessage(text, cfg as any, { type, accountId, limit });
      sendJson(res, 200, result);
      return;
    }
    
    // GET / - API 文档
    if (pathname === "/" && method === "GET") {
      sendJson(res, 200, {
        name: "QQBot Proactive Message API",
        version: "1.0.0",
        endpoints: {
          "POST /send": {
            description: "发送主动消息",
            body: {
              to: "目标 openid (必需)",
              text: "消息内容 (必需)",
              type: "消息类型: c2c | group (默认 c2c)",
              accountId: "账户 ID (默认 default)",
            },
          },
          "GET /users": {
            description: "列出已知用户",
            query: {
              type: "过滤类型: c2c | group | channel",
              accountId: "过滤账户 ID",
              limit: "限制返回数量",
            },
          },
          "GET /users/stats": {
            description: "获取用户统计",
            query: {
              accountId: "过滤账户 ID",
            },
          },
          "GET /users/:openid": {
            description: "获取单个用户信息",
            query: {
              type: "用户类型 (默认 c2c)",
              accountId: "账户 ID (默认 default)",
            },
          },
          "POST /broadcast": {
            description: "广播消息给所有已知用户",
            body: {
              text: "消息内容 (必需)",
              type: "消息类型: c2c | group (默认 c2c)",
              accountId: "账户 ID",
              limit: "限制发送数量",
            },
          },
        },
        notes: [
          "只有曾经与机器人交互过的用户才能收到主动消息",
        ],
      });
      return;
    }
    
    // 404
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(`Error handling request: ${err}`);
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// 解析监听端口（已在 ENV_CONFIG 中提取）
function getPort(): number {
  return ENV_CONFIG.cliPort || ENV_CONFIG.port || DEFAULT_PORT;
}

// 启动服务器
function main() {
  const port = getPort();
  
  const server = http.createServer(handleRequest);
  
  server.listen(port, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║         QQBot Proactive Message API Server                    ║
╠═══════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${port.toString().padEnd(25)}║
║                                                               ║
║  Endpoints:                                                   ║
║    GET  /              - API documentation                    ║
║    POST /send          - Send proactive message               ║
║    GET  /users         - List known users                     ║
║    GET  /users/stats   - Get user statistics                  ║
║    POST /broadcast     - Broadcast message                    ║
║                                                               ║
║  Example:                                                     ║
║    curl -X POST http://localhost:${port}/send \\                ║
║      -H "Content-Type: application/json" \\                    ║
║      -d '{"to":"openid","text":"Hello!"}'                     ║
╚═══════════════════════════════════════════════════════════════╝
`);
  });
  
  // 优雅关闭
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    server.close(() => {
      process.exit(0);
    });
  });
}

main();
