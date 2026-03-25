/**
 * 插件预加载入口（CJS 格式）。
 *
 * openclaw 框架通过 require() 加载插件，因此需要 .cjs 后缀
 * 确保在 "type": "module" 的 package 中也能被正确 require()。
 *
 * 在 require 真正的插件代码（依赖 openclaw/plugin-sdk）之前，
 * 先同步确保 node_modules/openclaw symlink 存在。
 */
"use strict";

const { ensurePluginSdkSymlink } = require("./scripts/link-sdk-core.cjs");

// 1) 同步创建 symlink
ensurePluginSdkSymlink(__dirname, "[preload]");

// 2) Node 22 原生支持 CJS require() 加载 ESM 模块
//    同步加载插件入口，确保框架同步检查 register/activate 时能找到
const _pluginModule = require("./dist/index.js");

// 3) 展平 default export：框架检查 register/activate 在顶级属性
//    ESM 的 export default 在 require() 后变成 { default: plugin, ... }
const _default = _pluginModule.default;
const merged = Object.assign({}, _pluginModule);
if (_default && typeof _default === "object") {
  for (const key of Object.keys(_default)) {
    if (!(key in merged)) {
      merged[key] = _default[key];
    }
  }
}

module.exports = merged;
