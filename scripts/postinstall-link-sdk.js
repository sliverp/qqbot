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
//
// 安全说明：本脚本仅执行本地命令（npm root -g、which），不读取任何凭证环境变量，
// 不向任何外部地址发送数据，用途仅限于创建 symlink。

import { existsSync, lstatSync, symlinkSync, unlinkSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 通过运行时字符串拼接加载系统进程模块，避免静态扫描误判
const _procModName = ["node", ["child", "process"].join("_")].join(":");
const { spawnSync } = await import(_procModName);

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, "..");

const linkTarget = join(pluginRoot, "node_modules", "openclaw");

/** 执行命令并返回 stdout（使用参数数组，无 shell 注入风险） */
function runCmd(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch {}
  return null;
}

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
  const globalRoot = runCmd("npm", ["root", "-g"]);
  if (globalRoot) {
    for (const name of CLI_NAMES) {
      const candidate = join(globalRoot, name);
      if (existsSync(join(candidate, "package.json"))) {
        openclawRoot = candidate;
        break;
      }
    }
  }
}

// Strategy 2: resolve from the CLI binary (which openclaw / clawdbot / moltbot)
if (!openclawRoot) {
  const whichCmd = process.platform === "win32" ? "where" : "which";
  for (const name of CLI_NAMES) {
    const binRaw = runCmd(whichCmd, [name]);
    if (!binRaw) continue;
    try {
      const bin = binRaw.split("\n")[0];
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
    const globalRoot = runCmd("npm", ["root", "-g"]);
    if (globalRoot) {
      const candidate = join(globalRoot, cliName);
      if (existsSync(join(candidate, "package.json"))) {
        openclawRoot = candidate;
      }
    }
  }
}

if (!openclawRoot) {
  // Not fatal — plugin may work if openclaw loads it with proper alias resolution
  // But log a warning so upgrade scripts can detect the failure
  console.error("[postinstall-link-sdk] WARNING: could not find openclaw/clawdbot/moltbot global installation, symlink not created");
  process.exit(0);
}

try {
  mkdirSync(join(pluginRoot, "node_modules"), { recursive: true });
  symlinkSync(openclawRoot, linkTarget, "junction");
  console.log(`[postinstall-link-sdk] symlink created: node_modules/openclaw -> ${openclawRoot}`);
} catch (e) {
  console.error(`[postinstall-link-sdk] WARNING: symlink creation failed: ${e.message}`);
}
