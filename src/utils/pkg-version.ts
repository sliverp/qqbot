/**
 * 从 import.meta.url 向上遍历目录树查找 package.json 并读取 version。
 * 不依赖硬编码的 "../" 层级，无论编译输出结构如何变化都能可靠找到。
 */

import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

/** 已定位到的 package.json 路径，避免重复遍历目录树 */
let _resolvedPkgPath: string | null = null;

export function getPackageVersion(metaUrl?: string): string {
  // 如果之前已定位到 package.json 路径，直接重新读取（快速路径）
  if (_resolvedPkgPath) {
    try {
      const pkg = JSON.parse(fs.readFileSync(_resolvedPkgPath, "utf8"));
      if (pkg.name === "@tencent-connect/openclaw-qqbot" && pkg.version) {
        return pkg.version as string;
      }
    } catch {
      // 文件可能已被删除（升级过程中），清除路径缓存，走完整查找
      _resolvedPkgPath = null;
    }
  }

  // Strategy 1: 从调用者的 import.meta.url（或本模块）向上遍历找 package.json
  const startFile = metaUrl ? fileURLToPath(metaUrl) : fileURLToPath(import.meta.url);
  let dir = path.dirname(startFile);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const candidate = path.join(dir, "package.json");
    try {
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
        // 确认是我们自己的包（避免找到其他 package.json）
        if (pkg.name === "@tencent-connect/openclaw-qqbot" && pkg.version) {
          _resolvedPkgPath = candidate;
          return pkg.version as string;
        }
      }
    } catch {
      // ignore and try parent
    }
    dir = path.dirname(dir);
  }

  // Strategy 2: fallback 用 createRequire 尝试常见相对路径
  try {
    const require = createRequire(metaUrl ?? import.meta.url);
    for (const rel of ["../../package.json", "../package.json", "./package.json"]) {
      try {
        const pkg = require(rel);
        if (pkg?.version) {
          return pkg.version as string;
        }
      } catch { /* next */ }
    }
  } catch { /* fallback */ }

  return "unknown";
}
