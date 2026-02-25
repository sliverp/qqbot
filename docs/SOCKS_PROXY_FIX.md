# SOCKS5 代理修复文档

## 问题背景

### 需求
为了让 QQ Bot API 请求通过云端固定 IP 的 SOCKS5 代理服务器发送，需要在 QQ Bot 后台配置 IP 白名单。

### 环境配置
- 代理服务器：`socks5h://100.67.x.x:1080`（SOCKS5 代理，DNS 也走代理）
- 代理出口 IP：`43.167.x.x`（需要在 QQ Bot 后台白名单中添加）
- 配置文件：`~/.openclaw/openclaw.json`

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "***",
      "clientSecret": "***",
      "proxyUrl": "socks5h://100.67.x.x:1080"
    }
  }
}
```

### 问题现象
- ✅ curl 测试通过代理可以正常访问 QQ Bot API
- ❌ 代码请求返回 `401 接口访问源 IP 不在白名单`

```bash
# curl 测试成功
curl --proxy socks5h://100.67.x.x:1080 "https://api.sgroup.qq.com/gateway" \
  -H "Authorization: QQBot <token>"
# 返回：{"url":"wss://api.sgroup.qq.com/websocket"}
```

---

## 问题诊断过程

### 1. 初步排查

**假设 1：代理配置没有正确读取**

添加了详细的调试日志：
- `config.ts`: 打印 `proxyUrl` 解析过程
- `gateway.ts`: 打印 API 配置初始化
- `api.ts`: 打印 Token 获取和 API 请求
- `proxy.ts`: 打印 Agent 创建和缓存

日志显示配置正确读取：
```
[qqbot-config]   => effectiveProxyUrl=socks5h://100.67.x.x:1080
[qqbot-proxy] ✅ Proxy agent created successfully: socks5h://100.67.x.x:1080
[qqbot-api] >>> Using proxy: socks5h://100.67.x.x:1080
```

**结论**：配置读取正确，代理 Agent 创建成功。

---

### 2. 深入分析

**假设 2：`socks5h://` 被错误转换成 `socks5://`**

发现代码中有以下转换：
```typescript
const normalizedUrl = proxyUrl.replace(/^socks5h:\/\//, 'socks5://');
```

- `socks5h://` - DNS 通过代理远程解析（推荐）
- `socks5://` - DNS 在本地解析

**修复**：保留原始 URL，`SocksProxyAgent` 原生支持 `socks5h://` 前缀。

**结果**：问题依然存在。

---

### 3. 根因定位

**假设 3：undici + SocksProxyAgent 集成方式错误**

原始代码使用 `Symbol.for("undici.customDispatcher")` 来集成 `SocksProxyAgent`：

```typescript
const undiciDispatcher = new Agent({
  connect: {
    [Symbol.for("undici.customDispatcher")]: socksAgent,
  } as any,
});
```

**关键发现**：这不是 undici 支持的标准 API！导致代理实际上没有生效。

### 验证测试

```bash
# 测试 1: curl (成功)
curl --proxy socks5h://100.67.x.x:1080 https://api.sgroup.qq.com/gateway
# 日志：SOCKS5 connect to ... (remotely resolved)
# 结果：200 OK

# 测试 2: https.Agent + SocksProxyAgent (成功)
node -e "
const { SocksProxyAgent } = require('socks-proxy-agent');
const https = require('https');
const agent = new SocksProxyAgent('socks5h://100.67.x.x:1080');
https.get('https://api.sgroup.qq.com/gateway', { agent }, ...)
"
# 结果：500 token not exist (说明代理生效了，只是 token 无效)

# 测试 3: undici.Agent + socksAgent.options (失败)
node -e "
const { SocksProxyAgent } = require('socks-proxy-agent');
const { Agent } = require('undici');
const undiciAgent = new Agent({ connect: socksAgent.options });
"
# 结果：401 接口访问源 IP 不在白名单
```

### 根本原因

`undici.Agent` 使用 `socksAgent.options` 时丢失了 `shouldLookup` 信息，导致 DNS 在本地解析而不是通过 SOCKS 代理远程解析。

**技术细节**：
- `SocksProxyAgent.options` 包含 `{ host, port, type }` 等信息
- 但 `shouldLookup: true`（DNS 远程解析的标志）没有正确传递
- 导致 DNS 在本地解析，出口 IP 不是代理服务器的 IP

---

## 解决方案

### 方案选择

| 方案 | 描述 | 优缺点 |
|------|------|--------|
| A | 改用 `https` 模块 + `SocksProxyAgent` | ✅ 最简单，已验证有效 |
| B | 修复 `getUndiciDispatcher` | ❌ undici 不原生支持 SOCKS |
| C | 全局设置代理 | ❌ 影响其他模块 |

**选择方案 A**：改用 Node.js 原生 `https` 模块。

---

## 代码修改

### 1. 修改 `src/api.ts`

添加 `httpsRequest` 辅助函数：

```typescript
import https from "node:https";
import http from "node:http";
import type { Agent as HttpsAgent } from "node:https";

/**
 * 使用 https 模块 + SocksProxyAgent 发送请求
 */
async function httpsRequest(
  url: string,
  options: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    agent?: HttpsAgent;
  }
): Promise<Response> {
  const { method, headers, body, agent } = options;
  const urlObj = new URL(url);

  return new Promise<Response>((resolve, reject) => {
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method,
      headers,
      agent,
    };

    const req = (urlObj.protocol === "https:" ? https : http).request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks);
        const response = new Response(responseBody, {
          status: res.statusCode || 200,
          headers: res.headers as Record<string, string>,
        });
        resolve(response);
      });
    });

    req.on("error", reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}
```

修改 `doFetchToken` 函数：

```typescript
async function doFetchToken(appId: string, clientSecret: string): Promise<string> {
  // ...
  if (proxyAgent) {
    console.log(`[qqbot-api-doFetchToken] >>> Sending token request via https+proxy`);
    response = await httpsRequest(TOKEN_URL, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
      agent: proxyAgent,
    });
  }
  // ...
}
```

修改 `apiRequest` 函数：

```typescript
export async function apiRequest<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number
): Promise<T> {
  // ...
  if (proxyUrl) {
    const proxyAgent = getProxyAgent(proxyUrl);
    if (proxyAgent) {
      console.log(`[qqbot-api] >>> Sending request via https+proxy to ${url}`);
      res = await httpsRequest(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        agent: proxyAgent,
      });
    }
  }
  // ...
}
```

### 2. 修改 `src/utils/proxy.ts`

修复 `getProxyAgent` 函数，保留 `socks5h://` 前缀：

```typescript
export function getProxyAgent(proxyUrl?: string): SocksProxyAgent | null {
  if (!proxyUrl) {
    return null;
  }

  // SocksProxyAgent 支持 socks5:// 和 socks5h:// 前缀
  // socks5h:// 表示 DNS 也走代理（推荐）
  const normalizedUrl = proxyUrl;  // 不再转换！

  if (globalProxyAgent && cachedProxyUrl === normalizedUrl) {
    return globalProxyAgent;
  }

  try {
    globalProxyAgent = new SocksProxyAgent(normalizedUrl);
    cachedProxyUrl = normalizedUrl;
    return globalProxyAgent;
  } catch (err) {
    return null;
  }
}
```

---

## 验证

### 编译
```bash
cd /Users/corrinehu/.openclaw/extensions/qqbot
npm run build
```

### 重启 Gateway
```bash
openclaw gateway
```

### 预期日志
```
[qqbot-config]   => effectiveProxyUrl=socks5h://100.67.x.x:1080
[qqbot-proxy] ✅ Proxy agent created successfully: socks5h://100.67.x.x:1080
[qqbot-api-doFetchToken] >>> Sending token request via https+proxy
[qqbot-api] <<< Status: 200
[qqbot-api] >>> Sending request via https+proxy to https://api.sgroup.qq.com/gateway
[qqbot-api] <<< Status: 200
```

### 测试结果
- ✅ Token 获取成功（200）
- ✅ Gateway 地址获取成功（200）
- ✅ WebSocket 连接成功

---

## 关键知识点

### 1. `socks5://` vs `socks5h://`
- `socks5://` - DNS 在本地解析（可能泄露 DNS 或无法解析内网域名）
- `socks5h://` - DNS 通过代理远程解析（推荐）

### 2. `SocksProxyAgent` 的集成方式
- ✅ **正确**：`https.Agent + SocksProxyAgent`（Node.js 原生支持）
- ❌ **错误**：`undici.Agent + socksAgent.options`（丢失 `shouldLookup` 信息）

### 3. 调试技巧
- 添加详细日志追踪配置传递链路
- 使用 curl 验证代理是否工作
- 对比 curl 和代码的行为差异

---

## 相关文件

| 文件 | 修改内容 |
|------|----------|
| `src/api.ts` | 添加 `httpsRequest` 函数，修改 `doFetchToken` 和 `apiRequest` |
| `src/utils/proxy.ts` | 修复 `getProxyAgent`，保留 `socks5h://` 前缀 |
| `src/gateway.ts` | 添加调试日志 |
| `src/config.ts` | 添加调试日志 |

---

## 日期
- 问题发现：2026-02-25
- 问题解决：2026-02-26
- 修复版本：v1.5.0

---

## 上游同步

### 背景

此修复是在 `corrinehu/qqbot` fork 中开发的，上游仓库是 `sliverp/qqbot`。

由于这是新增功能（而非 bug 修复），上游作者可能会拒绝合并。因此需要保持与上游的同步。

### 同步上游更新

```bash
# 1. 获取上游最新代码
git fetch upstream

# 2. 切换到主分支
git checkout main

# 3. 合并上游主分支
git merge upstream/main

# 4. 切换到功能分支
git checkout feature/proxy-support

# 5. 合并主分支的更新
git merge main

# 6. 解决可能的冲突（如果有）
# ...

# 7. 推送到你的 fork
git push origin feature/proxy-support
```

### 版本关系

| 版本 | 上游版本 | 说明 |
|------|---------|------|
| v1.5.0+proxy | v1.5.0 | 添加 SOCKS5 代理支持 |

### 注意事项

1. **冲突解决**：如果上游修改了 `src/api.ts`、`src/config.ts` 或 `src/utils/proxy.ts`，可能需要手动解决冲突

2. **测试**：同步后务必重新测试代理功能

3. **依赖**：确保 `package.json` 中的 `socks-proxy-agent` 依赖被保留

---

## Git 分支策略

### 当前状态

```
上游仓库：https://github.com/sliverp/qqbot (upstream)
你的仓库：https://github.com/corrinehu/qqbot (origin)
功能分支：feature/proxy-support
```

### 分支历史

```
upstream/main (原始作者的主分支)
     │
     └─────────────────────────────────┐
                                       │
corrinehu/main (你的 fork 主分支) ──────┘
     │
     └── feature/proxy-support (当前修复分支)
```

### 快速命令参考

```bash
# 查看远程仓库
git remote -v
# origin    https://github.com/corrinehu/qqbot.git
# upstream  https://github.com/sliverp/qqbot.git

# 查看分支
git branch -a

# 推送当前分支到你的 fork
git push origin feature/proxy-support

# 拉取上游最新代码
git fetch upstream
git checkout main
git merge upstream/main
git push origin main

# 同步功能分支
git checkout feature/proxy-support
git merge main
git push origin feature/proxy-support
```

### 如果上游接受了 PR

如果上游作者合并了你的修复：

1. 删除功能分支：`git branch -d feature/proxy-support`
2. 更新主分支：`git fetch upstream && git merge upstream/main`
3. 正常使用即可，不再需要 fork
