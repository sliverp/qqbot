/**
 * 公共模块：openclaw plugin-sdk symlink 创建逻辑。
 *
 * 被 preload.cjs 和 postinstall-link-sdk.js 共同使用，避免代码重复。
 * 必须是 CJS 格式，因为 preload.cjs 需要同步 require()。
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { execSync } = require("node:child_process");

const CLI_NAMES = ["openclaw", "clawdbot", "moltbot"];

/**
 * 比较版本号是否 >= target
 * Strip pre-release suffix (e.g. "2026.3.23-2" → "2026.3.23")
 */
function compareVersionGte(version, target) {
  const parts = version.replace(/-.*$/, "").split(".").map(Number);
  for (let i = 0; i < target.length; i++) {
    const v = parts[i] || 0;
    const t = target[i];
    if (v > t) return true;
    if (v < t) return false;
  }
  return true;
}

/**
 * 检查 openclaw 版本是否 >= 2026.3.22（需要 symlink 的最低版本）。
 * 如果无法检测版本，返回 true（保守策略：宁可多创建也不遗漏）。
 */
function isOpenclawVersionRequiresSymlink() {
  const REQUIRED = [2026, 3, 22];

  // Strategy 1: 从全局 openclaw 的 package.json 读取版本
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf-8", timeout: 5000 }).trim();
    for (const name of CLI_NAMES) {
      const pkgPath = path.join(globalRoot, name, "package.json");
      if (fs.existsSync(pkgPath)) {
        const v = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
        if (v) return compareVersionGte(v, REQUIRED);
      }
    }
  } catch {}

  // Strategy 2: 从 CLI 命令获取版本
  for (const name of CLI_NAMES) {
    try {
      const out = execSync(`${name} --version`, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const m = out.match(/(\d+\.\d+\.\d+)/);
      if (m) return compareVersionGte(m[1], REQUIRED);
    } catch {}
  }

  return true;
}

/**
 * 查找全局 openclaw 安装路径。
 * 三种策略依次尝试：npm root -g、which <cli>、从 extensions 目录推断。
 */
function findOpenclawRoot(pluginRoot) {
  // Strategy 1: npm root -g
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf-8", timeout: 5000 }).trim();
    for (const name of CLI_NAMES) {
      const candidate = path.join(globalRoot, name);
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    }
  } catch {}

  // Strategy 2: which <cli>
  const whichCmd = process.platform === "win32" ? "where" : "which";
  for (const name of CLI_NAMES) {
    try {
      const bin = execSync(`${whichCmd} ${name}`, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim().split("\n")[0];
      if (!bin) continue;
      const realBin = fs.realpathSync(bin);
      const c1 = path.resolve(path.dirname(realBin), "..", "lib", "node_modules", name);
      if (fs.existsSync(path.join(c1, "package.json"))) return c1;
      const c2 = path.resolve(path.dirname(realBin), "..");
      if (fs.existsSync(path.join(c2, "package.json")) && fs.existsSync(path.join(c2, "plugin-sdk"))) return c2;
    } catch {}
  }

  // Strategy 3: 从 extensions 目录推断
  const extensionsDir = path.dirname(pluginRoot);
  const dataDir = path.dirname(extensionsDir);
  const dataDirName = path.basename(dataDir);
  const cliName = dataDirName.replace(/^\./, "");
  if (cliName) {
    try {
      const globalRoot = execSync("npm root -g", { encoding: "utf-8", timeout: 5000 }).trim();
      const candidate = path.join(globalRoot, cliName);
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    } catch {}
  }

  return null;
}

/**
 * 验证现有 node_modules/openclaw 是否完整可用。
 *
 * openclaw plugins install 可能安装了不完整的 peerDep 副本
 * （只有 dist/plugin-sdk/index.js，缺少 core.js 等子模块），覆盖了之前的 symlink。
 *
 * 判断标准：
 * - symlink → 只需确认 dist/plugin-sdk 目录存在（target 有完整文件树）
 * - 真实目录 → 必须检查 dist/plugin-sdk/core.js 是否存在
 */
function isLinkValid(linkTarget) {
  try {
    const stat = fs.lstatSync(linkTarget);
    if (stat.isSymbolicLink()) {
      return fs.existsSync(path.join(linkTarget, "dist", "plugin-sdk"))
        || fs.existsSync(path.join(linkTarget, "plugin-sdk"));
    }
    // 真实目录
    return fs.existsSync(path.join(linkTarget, "dist", "plugin-sdk", "core.js"));
  } catch {
    return false;
  }
}

/**
 * 确保 plugin-sdk symlink 存在。
 *
 * @param {string} pluginRoot - 插件根目录路径
 * @param {string} [tag="[link-sdk]"] - 日志前缀
 * @returns {boolean} true 如果 symlink 已存在或成功创建
 */
function ensurePluginSdkSymlink(pluginRoot, tag) {
  tag = tag || "[link-sdk]";
  try {
    if (!pluginRoot.includes("extensions")) return true;

    const linkTarget = path.join(pluginRoot, "node_modules", "openclaw");

    if (fs.existsSync(linkTarget)) {
      if (isLinkValid(linkTarget)) return true;
      // 无效/不完整 → 删除后重建
      try {
        fs.rmSync(linkTarget, { recursive: true, force: true });
        console.log(`${tag} removed incomplete node_modules/openclaw`);
      } catch {}
    }

    if (!isOpenclawVersionRequiresSymlink()) return true;

    const openclawRoot = findOpenclawRoot(pluginRoot);
    if (!openclawRoot) {
      console.error(`${tag} WARNING: could not find openclaw global installation, symlink not created`);
      return false;
    }

    fs.mkdirSync(path.join(pluginRoot, "node_modules"), { recursive: true });
    fs.symlinkSync(openclawRoot, linkTarget, "junction");
    console.log(`${tag} symlink created: node_modules/openclaw -> ${openclawRoot}`);
    return true;
  } catch (e) {
    console.error(`${tag} WARNING: symlink check failed: ${e.message || e}`);
    return false;
  }
}

module.exports = {
  CLI_NAMES,
  compareVersionGte,
  isOpenclawVersionRequiresSymlink,
  findOpenclawRoot,
  isLinkValid,
  ensurePluginSdkSymlink,
};
