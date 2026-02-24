#!/usr/bin/env node

/**
 * QQBot CLI - 用于升级和管理 QQBot 插件
 * 
 * 用法:
 *   npx @sliverp/qqbot upgrade    # 升级插件
 *   npx @sliverp/qqbot install    # 安装插件
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 获取包的根目录
const PKG_ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0];

// 检测使用的是 clawdbot 还是 openclaw
function detectInstallation() {
  const home = homedir();
  if (existsSync(join(home, '.openclaw'))) {
    return 'openclaw';
  }
  if (existsSync(join(home, '.clawdbot'))) {
    return 'clawdbot';
  }
  return null;
}

// 清理旧版本插件，返回旧的 qqbot 配置
function cleanupInstallation(appName) {
  const home = homedir();
  const appDir = join(home, `.${appName}`);
  const configFile = join(appDir, `${appName}.json`);
  const extensionDir = join(appDir, 'extensions', 'qqbot');

  let oldQqbotConfig = null;

  console.log(`\n>>> 处理 ${appName} 安装...`);

  // 1. 先读取旧的 qqbot 配置
  if (existsSync(configFile)) {
    try {
      const config = JSON.parse(readFileSync(configFile, 'utf8'));
      if (config.channels?.qqbot) {
        oldQqbotConfig = { ...config.channels.qqbot };
        console.log('已保存旧的 qqbot 配置');
      }
    } catch (err) {
      console.error('读取配置文件失败:', err.message);
    }
  }

  // 2. 删除旧的扩展目录
  if (existsSync(extensionDir)) {
    console.log(`删除旧版本插件: ${extensionDir}`);
    rmSync(extensionDir, { recursive: true, force: true });
  } else {
    console.log('未找到旧版本插件目录，跳过删除');
  }

  // 3. 清理配置文件中的 qqbot 相关字段
  if (existsSync(configFile)) {
    console.log('清理配置文件中的 qqbot 字段...');
    try {
      const config = JSON.parse(readFileSync(configFile, 'utf8'));

      // 删除 channels.qqbot
      if (config.channels?.qqbot) {
        delete config.channels.qqbot;
        console.log('  - 已删除 channels.qqbot');
      }

      // 删除 plugins.entries.qqbot
      if (config.plugins?.entries?.qqbot) {
        delete config.plugins.entries.qqbot;
        console.log('  - 已删除 plugins.entries.qqbot');
      }

      // 删除 plugins.installs.qqbot
      if (config.plugins?.installs?.qqbot) {
        delete config.plugins.installs.qqbot;
        console.log('  - 已删除 plugins.installs.qqbot');
      }

      writeFileSync(configFile, JSON.stringify(config, null, 2));
      console.log('配置文件已更新');
    } catch (err) {
      console.error('清理配置文件失败:', err.message);
    }
  } else {
    console.log(`未找到配置文件: ${configFile}`);
  }

  return oldQqbotConfig;
}

// 执行命令并继承 stdio
function runCommand(cmd, args = []) {
  try {
    execSync([cmd, ...args].join(' '), { stdio: 'inherit' });
    return true;
  } catch (err) {
    return false;
  }
}

// 升级命令
function upgrade() {
  console.log('=== QQBot 插件升级脚本 ===');

  let foundInstallation = null;
  let savedConfig = null;
  const home = homedir();

  // 检查 openclaw
  if (existsSync(join(home, '.openclaw'))) {
    savedConfig = cleanupInstallation('openclaw');
    foundInstallation = 'openclaw';
  }

  // 检查 clawdbot
  if (existsSync(join(home, '.clawdbot'))) {
    const clawdbotConfig = cleanupInstallation('clawdbot');
    if (!savedConfig) savedConfig = clawdbotConfig;
    foundInstallation = 'clawdbot';
  }

  if (!foundInstallation) {
    console.log('\n未找到 clawdbot 或 openclaw 安装目录');
    console.log('请确认已安装 clawdbot 或 openclaw');
    process.exit(1);
  }

  console.log('\n=== 清理完成 ===');

  // 自动安装插件
  console.log('\n[1/2] 安装新版本插件...');
  runCommand(foundInstallation, ['plugins', 'install', '@sliverp/qqbot']);

  // 自动配置通道（使用保存的 appId 和 clientSecret）
  console.log('\n[2/2] 配置机器人通道...');
  if (savedConfig?.appId && savedConfig?.clientSecret) {
    const token = `${savedConfig.appId}:${savedConfig.clientSecret}`;
    console.log(`使用已保存的配置: appId=${savedConfig.appId}`);
    runCommand(foundInstallation, ['channels', 'add', '--channel', 'qqbot', '--token', `"${token}"`]);
    
    // 恢复其他配置项（如 markdownSupport）
    if (savedConfig.markdownSupport !== undefined) {
      runCommand(foundInstallation, ['config', 'set', 'channels.qqbot.markdownSupport', String(savedConfig.markdownSupport)]);
    }
  } else {
    console.log('未找到已保存的 qqbot 配置，请手动配置:');
    console.log(`  ${foundInstallation} channels add --channel qqbot --token "AppID:AppSecret"`);
    return;
  }

  console.log('\n=== 升级完成 ===');
  console.log(`\n可以运行以下命令前台运行启动机器人:`);
  console.log(`  ${foundInstallation} gateway  stop && ${foundInstallation} gateway --port 18789 --verbose`);
}

// 安装命令
function install() {
  console.log('=== QQBot 插件安装 ===');

  const cmd = detectInstallation();
  if (!cmd) {
    console.log('未找到 clawdbot 或 openclaw 安装');
    console.log('请先安装 openclaw 或 clawdbot');
    process.exit(1);
  }

  console.log(`\n使用 ${cmd} 安装插件...`);
  runCommand(cmd, ['plugins', 'install', '@sliverp/qqbot']);

  console.log('\n=== 安装完成 ===');
  console.log('\n请配置机器人通道:');
  console.log(`  ${cmd} channels add --channel qqbot --token "AppID:AppSecret"`);
}

// 显示帮助
function showHelp() {
  console.log(`
QQBot CLI - QQ机器人插件管理工具

用法:
  npx @sliverp/qqbot <命令>

命令:
  upgrade       清理旧版本插件（升级前执行）
  install       安装插件到 openclaw/clawdbot

示例:
  npx @sliverp/qqbot upgrade
  npx @sliverp/qqbot install
`);
}

// 主入口
switch (command) {
  case 'upgrade':
    upgrade();
    break;
  case 'install':
    install();
    break;
  case '-h':
  case '--help':
  case 'help':
    showHelp();
    break;
  default:
    if (command) {
      console.log(`未知命令: ${command}`);
    }
    showHelp();
    process.exit(command ? 1 : 0);
}
