---
name: qqbot-upgrade
description: 检查 openclaw-qqbot 插件是否有新版本，告知用户版本信息，经用户确认后再通过官方脚本升级。当用户询问 QQ 机器人插件是否有更新、要求升级 qqbot 扩展或同步官方最新版时使用。
metadata: {"openclaw":{"emoji":"⬆️","requires":{"config":["channels.qqbot"]}}}
---

# QQBot 插件升级

## 何时使用

用户表达以下意图时触发此技能：

- 询问 `openclaw-qqbot` 或 QQBot 插件**是否有新版本**
- 更新 / 升级 `openclaw-qqbot` 或 QQBot 插件
- 拉取官方最新 npm 包
- 执行与「upgrade-via-npm」相关的操作

---

## 执行流程（必须严格按顺序）

### 第 1 步：查询版本信息

先分别获取**本地已安装版本**和 **npm 远端最新版本**，在终端执行：

```bash
# 本地版本（在扩展目录读取 package.json）
LOCAL_VER=$(node -e "console.log(require('～/.openclaw/extensions/openclaw-qqbot/package.json').version)" 2>/dev/null || echo "未知")

# 远端最新版本
REMOTE_VER=$(npm view @tencent-connect/openclaw-qqbot version 2>/dev/null || echo "查询失败")

echo "本地版本: $LOCAL_VER"
echo "远端最新: $REMOTE_VER"
```

### 第 2 步：向用户报告并等待确认

将查询结果**清晰地告知用户**，例如：

> 当前本地版本：x.y.z，npm 最新版本：a.b.c。

- 若版本相同，告知用户「已是最新版本，无需升级」，**流程结束**。
- 若有新版本，**必须先告知用户升级预计耗时及影响，再询问是否升级**，例如：「发现新版本 a.b.c（当前 x.y.z）。升级预计需要 5–10 分钟，升级过程中无法回复消息，请耐心等待。是否要升级？」
- ⚠️ **禁止跳过此步骤直接执行升级命令。必须等用户明确回复确认（如「好」「是」「升级」「确认」等肯定表达）后，才进入第 3 步。**

### 第 3 步：执行升级（仅在用户确认后）

在 **bash** 环境中执行（需已安装 `curl`，且能访问 GitHub）：

```bash
curl -fsSL https://raw.githubusercontent.com/tencent-connect/openclaw-qqbot/main/scripts/upgrade-via-npm.sh | bash
```

说明：

- `-f`：HTTP 错误时失败；`-sS`：静默但保留错误输出；`-L`：跟随重定向
- 脚本由 [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot) 仓库 `main` 分支提供，通过 npm 完成升级流程（具体步骤以脚本为准）

---

## 代理与前置条件

- 若网络无法直连 GitHub，需由用户配置代理或镜像后再执行；代理应作用于当前 shell（如 `HTTPS_PROXY`）
- 脚本通常会依赖 **Node.js / npm** 环境；若命令失败，根据终端报错检查 PATH、权限与 npm 登录状态

---

## 安全提示

管道执行远程脚本属于**远程代码执行**：仅适用于用户明确请求升级且信任该官方仓库的场景。不要替换为未经验证的 URL。

---

## 执行后

根据脚本退出码与终端输出向用户简要汇报：成功则说明已按官方流程升级；失败则摘录关键错误并提示检查网络、Node/npm 与权限。

- ⚠️ **升级脚本已包含自动重启 gateway 的步骤，升级成功后不要再提示用户手动重启 gateway。**
