/**
 * QQ Bot 文件服务器
 * 
 * 提供安全的文件访问服务，通过 OpenClaw 的 HTTP 端口注册路由，
 * 使用 token 验证确保文件不被未授权访问。
 * 
 * 访问格式: http://ip:port/qqbot/static?file=xxx&token=xxx
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as https from "node:https";
import * as http from "node:http";

// ============ 图片扩展名集合 ============
/** 被视为图片的扩展名（小写），<qqfile> 中遇到这些扩展名会自动转为 <qqimg> */
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);

/**
 * 判断文件路径是否为图片
 */
export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

// ============ 文件 Token 管理 ============

interface FileToken {
  /** 文件的绝对路径 */
  filePath: string;
  /** 访问 token */
  token: string;
  /** 原始文件名 */
  originalName: string;
}

/** token -> FileToken 映射 */
const fileTokenStore = new Map<string, FileToken>();

/**
 * 生成安全的随机 token
 */
function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * 为文件注册一个访问 token
 * @returns { token, fileName } 用于构建访问 URL
 */
export function registerFileToken(
  filePath: string,
): { token: string; fileName: string } | null {
  // 验证文件存在
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`[file-server] File not found: ${absPath}`);
    return null;
  }

  const token = generateToken();
  const originalName = path.basename(absPath);

  fileTokenStore.set(token, {
    filePath: absPath,
    token,
    originalName,
  });

  console.log(`[file-server] Registered token for file: ${absPath}`);
  return { token, fileName: originalName };
}

/**
 * 验证 token 并返回文件路径
 */
export function resolveFileToken(token: string): { filePath: string; fileName: string } | null {
  const entry = fileTokenStore.get(token);
  if (!entry) return null;

  // 验证文件仍然存在
  if (!fs.existsSync(entry.filePath)) {
    fileTokenStore.delete(token);
    return null;
  }

  return { filePath: entry.filePath, fileName: entry.originalName };
}

// ============ HTTP 请求处理 ============

/**
 * 根据文件扩展名获取 MIME 类型
 */
function getMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    ".txt": "text/plain; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".7z": "application/x-7z-compressed",
    ".rar": "application/vnd.rar",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".avi": "video/x-msvideo",
    ".mov": "video/quicktime",
    ".log": "text/plain; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8",
    ".yml": "text/yaml; charset=utf-8",
    ".sh": "text/x-shellscript; charset=utf-8",
    ".py": "text/x-python; charset=utf-8",
    ".java": "text/x-java-source; charset=utf-8",
    ".ts": "text/typescript; charset=utf-8",
  };
  return mimeMap[ext.toLowerCase()] || "application/octet-stream";
}

/**
 * 处理 /qqbot/static 请求
 * 
 * 可以作为 OpenClaw 的 HTTP handler 注册，也可以独立处理
 */
export function handleFileRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): boolean {
  const urlObj = new URL(req.url || "/", `http://localhost`);
  
  // 探测端点：用于验证公网 IP 是否能到达本机
  if (urlObj.pathname === "/qqbot/ping") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("pong");
    return true;
  }

  // 只处理 /qqbot/static 路径
  if (urlObj.pathname !== "/qqbot/static") {
    return false;
  }

  // 只允许 GET
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return true;
  }

  const fileParam = urlObj.searchParams.get("file");
  const tokenParam = urlObj.searchParams.get("token");

  if (!fileParam || !tokenParam) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing required parameters: file, token");
    return true;
  }

  // 验证 token
  const resolved = resolveFileToken(tokenParam);
  if (!resolved) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Invalid or expired token");
    return true;
  }

  // 额外检查：file 参数中的文件名必须匹配 token 对应的文件名
  // 防止通过修改 file 参数来访问其他文件
  if (fileParam !== resolved.fileName) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("File name mismatch");
    return true;
  }

  // 安全检查：确保文件路径没有被篡改（防止目录遍历）
  const normalizedPath = path.resolve(resolved.filePath);
  if (normalizedPath !== resolved.filePath) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return true;
  }

  try {
    const stat = fs.statSync(resolved.filePath);
    if (!stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not a file");
      return true;
    }

    const ext = path.extname(resolved.fileName);
    const contentType = getMimeType(ext);

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Content-Disposition": `inline; filename="${encodeURIComponent(resolved.fileName)}"`,
      "Cache-Control": "private, max-age=3600",
    });

    const stream = fs.createReadStream(resolved.filePath);
    stream.pipe(res);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.end("Internal Server Error");
    });

    return true;
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
    return true;
  }
}

// ============ 公网 IP 检测 ============

/** 缓存的公网 IP */
let cachedPublicIp: string | null = null;
let lastIpCheckTime = 0;
/** IP 缓存时间: 10 分钟 */
const IP_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * 通过多个公共服务获取公网 IP
 * 获取后会通过回环探测验证该 IP 是否真的能访问到本机端口
 * @returns 公网 IP 地址，获取失败或无法回环访问时返回 null
 */
export async function getPublicIp(): Promise<string | null> {
  // 检查缓存
  if (cachedPublicIp && Date.now() - lastIpCheckTime < IP_CACHE_TTL_MS) {
    return cachedPublicIp;
  }

  const services = [
    "https://api.ipify.org",
    "https://ifconfig.me/ip",
    "https://icanhazip.com",
    "https://checkip.amazonaws.com",
  ];

  let detectedIp: string | null = null;

  for (const url of services) {
    try {
      const ip = await fetchIp(url);
      if (ip && isValidPublicIp(ip)) {
        detectedIp = ip;
        console.log(`[file-server] Public IP detected: ${ip} (from ${url})`);
        break;
      }
    } catch {
      // 尝试下一个服务
    }
  }

  if (!detectedIp) {
    console.error("[file-server] Failed to detect public IP from all services");
    return null;
  }

  // 关键检查：通过公网 IP 回环请求自己的探测端点，验证该 IP 是否真的能到达本机
  // 云主机的公网 IP 不在网卡上（弹性 IP / 浮动 IP），但端口是通的
  // 家庭 NAT 后面的公网 IP 是路由器的，端口不通
  const port = getOpenClawPort();
  const reachable = await probeself(detectedIp, port);

  if (!reachable) {
    console.error(
      `[file-server] Public IP ${detectedIp}:${port} is NOT reachable from itself — likely behind NAT without port mapping. File serving unavailable.`
    );
    return null;
  }

  cachedPublicIp = detectedIp;
  lastIpCheckTime = Date.now();
  console.log(`[file-server] Public IP verified reachable: ${detectedIp}:${port}`);
  return detectedIp;
}

/**
 * 从 URL 获取 IP
 */
function fetchIp(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data.trim()));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

/**
 * 检查是否是有效的公网 IP（非内网、非回环）
 */
function isValidPublicIp(ip: string): boolean {
  if (!ip) return false;
  
  // 基本 IPv4 格式验证
  const ipv4Regex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (!ipv4Regex.test(ip)) return false;

  const parts = ip.split(".").map(Number);
  if (parts.some(p => p < 0 || p > 255)) return false;

  // 排除内网地址
  // 10.0.0.0/8
  if (parts[0] === 10) return false;
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return false;
  // 127.0.0.0/8 (loopback)
  if (parts[0] === 127) return false;
  // 169.254.0.0/16 (link-local)
  if (parts[0] === 169 && parts[1] === 254) return false;
  // 100.64.0.0/10 (CGNAT / NAT)
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return false;

  return true;
}

/**
 * 通过公网 IP 回环请求探测端点，验证外部是否能通过该 IP 访问到本机
 * 
 * 请求 http://publicIp:port/qqbot/ping，如果返回 "pong" 则说明可达。
 * 适用于：
 * - 云主机弹性 IP（网卡上无公网 IP，但云平台 NAT 映射端口通）→ 通过
 * - 家庭 NAT（公网 IP 是路由器的，本机端口未映射）→ 不通过
 */
function probeself(publicIp: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const url = `http://${publicIp}:${port}/qqbot/ping`;
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve(data.trim() === "pong");
      });
      res.on("error", () => resolve(false));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ============ URL 生成 ============

/**
 * 获取 OpenClaw Gateway 的监听端口
 */
export function getOpenClawPort(): number {
  const envPort = process.env.OPENCLAW_GATEWAY_PORT || process.env.CLAWDBOT_GATEWAY_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 18789; // 默认端口
}

/**
 * 为本地文件生成公网可访问的下载 URL
 * 
 * @param filePath 本地文件路径
 * @param publicIp 公网 IP（如果已知）
 * @returns { url, fileName } 或 null（如果无法生成）
 */
export function generateFileUrl(
  filePath: string,
  publicIp: string,
): { url: string; fileName: string } | null {
  const registered = registerFileToken(filePath);
  if (!registered) return null;

  const port = getOpenClawPort();
  const { token, fileName } = registered;
  const encodedFileName = encodeURIComponent(fileName);
  const url = `http://${publicIp}:${port}/qqbot/static?file=${encodedFileName}&token=${token}`;

  return { url, fileName };
}

/**
 * 为文件生成 Markdown 链接格式
 * @returns markdown 格式的链接，如 [文件名](url)，或 null
 */
export function generateFileMarkdownLink(
  filePath: string,
  publicIp: string,
): string | null {
  const result = generateFileUrl(filePath, publicIp);
  if (!result) return null;
  return `[${result.fileName}](${result.url})`;
}
