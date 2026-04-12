/**
 * 插件预加载入口（CJS 格式）。
 *
 * openclaw 框架通过 require() 加载插件，因此需要 .cjs 后缀。
 * dist/index.js 已编译为 CJS（tsconfig "module": "CommonJS"），
 * 可直接 require() 无需任何 ESM 互操作。
 */
"use strict";

const { ensurePluginSdkSymlink } = require("./scripts/link-sdk-core.cjs");

// 1) 同步创建 symlink
ensurePluginSdkSymlink(__dirname, "[preload]");

// 2) 直接 require CJS 编译产物
module.exports = require("./dist/index.js");
