#!/usr/bin/env node

// When installed as an openclaw extension under ~/.openclaw/extensions/,
// the plugin needs access to `openclaw/plugin-sdk` at runtime.
// openclaw's jiti loader resolves this via alias by walking up from the plugin
// path to find the openclaw package root — but ~/.openclaw/extensions/ is not
// under the openclaw package tree, so the alias lookup fails.
//
// This script creates a symlink from the plugin's node_modules/openclaw to the
// globally installed openclaw package, allowing Node's native ESM resolver
// (used by jiti with tryNative:true for .js files) to find `openclaw/plugin-sdk`.

import { existsSync, lstatSync, symlinkSync, unlinkSync, rmSync, mkdirSync, realpathSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, "..");

const linkTarget = join(pluginRoot, "node_modules", "openclaw");

// Check if already a valid symlink pointing to a directory with plugin-sdk/core
if (existsSync(linkTarget)) {
  try {
    const stat = lstatSync(linkTarget);
    if (stat.isSymbolicLink()) {
      // Symlink exists — verify it has plugin-sdk/core
      if (existsSync(join(linkTarget, "plugin-sdk", "core.js"))) {
        process.exit(0);
      }
      // Symlink is stale or points to wrong target, remove and re-create
      unlinkSync(linkTarget);
    } else if (existsSync(join(linkTarget, "plugin-sdk", "core.js"))) {
      // Real directory with correct structure (e.g. npm installed a good version)
      process.exit(0);
    } else {
      // Real directory from npm install but missing plugin-sdk/core — replace with symlink
      rmSync(linkTarget, { recursive: true, force: true });
    }
  } catch {
    // If stat fails, try to remove and re-create
    try { rmSync(linkTarget, { recursive: true, force: true }); } catch {}
  }
}

// CLI names to try (openclaw and its aliases)
const CLI_NAMES = ["openclaw", "clawdbot", "moltbot"];

// Find the global openclaw installation
let openclawRoot = null;

// Strategy 1: npm root -g → look for any known CLI package name
if (!openclawRoot) {
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
    for (const name of CLI_NAMES) {
      const candidate = join(globalRoot, name);
      if (existsSync(join(candidate, "package.json"))) {
        openclawRoot = candidate;
        break;
      }
    }
  } catch {}
}

// Strategy 2: resolve from the CLI binary (which openclaw / clawdbot / moltbot)
if (!openclawRoot) {
  const whichCmd = process.platform === "win32" ? "where" : "which";
  for (const name of CLI_NAMES) {
    try {
      const bin = execSync(`${whichCmd} ${name}`, { encoding: "utf-8" }).trim().split("\n")[0];
      if (!bin) continue;
      // Resolve symlinks to get actual binary location
      const realBin = realpathSync(bin);
      // bin is typically <prefix>/bin/<name> -> ../lib/node_modules/<name>/...
      const candidate = resolve(dirname(realBin), "..", "lib", "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) {
        openclawRoot = candidate;
        break;
      }
      // Also try: binary might be inside the package itself (e.g. .../node_modules/<name>/bin/<name>)
      const candidate2 = resolve(dirname(realBin), "..");
      if (existsSync(join(candidate2, "package.json")) && existsSync(join(candidate2, "plugin-sdk"))) {
        openclawRoot = candidate2;
        break;
      }
    } catch {}
  }
}

// Strategy 3: walk up from the extensions directory to find the CLI's data root,
// then look for a global node_modules sibling
if (!openclawRoot) {
  // pluginRoot is like /home/user/.openclaw/extensions/openclaw-qqbot
  // The CLI data dir is /home/user/.openclaw (or .clawdbot, .moltbot)
  const extensionsDir = dirname(pluginRoot);
  const dataDir = dirname(extensionsDir);
  const dataDirName = dataDir.split("/").pop() || dataDir.split("\\").pop() || "";
  // dataDirName is like ".openclaw" → strip the dot to get "openclaw"
  const cliName = dataDirName.replace(/^\./, "");
  if (cliName) {
    try {
      const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
      const candidate = join(globalRoot, cliName);
      if (existsSync(join(candidate, "package.json"))) {
        openclawRoot = candidate;
      }
    } catch {}
  }
}

// Strategy 4: pnpm global installation
// pnpm 的全局安装路径结构与 npm 不同：
//   pnpm root -g → /root/.local/share/pnpm/global/5/node_modules
//   实际包在 .pnpm/<name>@<version>/node_modules/<name>/ 下
// 另外 pnpm 的 bin 通过 symlink 指向 .pnpm 中的实际文件
if (!openclawRoot) {
  try {
    const pnpmRoot = execSync("pnpm root -g", { encoding: "utf-8" }).trim();
    if (pnpmRoot) {
      for (const name of CLI_NAMES) {
        // 先检查 pnpm root -g 直接返回的路径（pnpm 会创建顶层 symlink）
        const directCandidate = join(pnpmRoot, name);
        if (existsSync(join(directCandidate, "package.json"))) {
          // 解析 symlink 获取真实路径
          try {
            const realPath = realpathSync(directCandidate);
            if (existsSync(join(realPath, "plugin-sdk", "core.js"))) {
              openclawRoot = realPath;
              break;
            }
            // 即使没有 plugin-sdk/core.js，也可以用
            if (existsSync(join(realPath, "package.json"))) {
              openclawRoot = realPath;
              break;
            }
          } catch {
            // 如果 realpath 失败，直接用 symlink 路径
            openclawRoot = directCandidate;
            break;
          }
        }
        // 扫描 .pnpm 目录查找匹配的包
        const pnpmDir = join(pnpmRoot, ".pnpm");
        if (existsSync(pnpmDir)) {
          try {
            const entries = readdirSync(pnpmDir);
            for (const entry of entries) {
              // pnpm 目录名格式: <name>@<version> 或 <name>@<version>_<hash>
              if (entry.startsWith(name + "@")) {
                const candidate = join(pnpmDir, entry, "node_modules", name);
                if (existsSync(join(candidate, "package.json"))) {
                  openclawRoot = candidate;
                  break;
                }
              }
            }
          } catch {}
        }
        if (openclawRoot) break;
      }
    }
  } catch {}
}

if (!openclawRoot) {
  // Not fatal — plugin may work if openclaw loads it with proper alias resolution
  // But log a warning so upgrade scripts can detect the failure
  // 使用 exit(1) 以便调用方能正确检测到 symlink 未创建
  console.error("[postinstall-link-sdk] WARNING: could not find openclaw/clawdbot/moltbot global installation, symlink not created");
  process.exit(1);
}

try {
  mkdirSync(join(pluginRoot, "node_modules"), { recursive: true });
  symlinkSync(openclawRoot, linkTarget, "junction");
  console.log(`[postinstall-link-sdk] symlink created: node_modules/openclaw -> ${openclawRoot}`);
} catch (e) {
  console.error(`[postinstall-link-sdk] WARNING: symlink creation failed: ${e.message}`);
}
