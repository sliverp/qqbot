---
name: qqbot-upgrade
description: 通过官方脚本将 openclaw-qqbot 插件升级到最新 npm 版本。当用户要求更新 QQ 机器人插件、升级 qqbot 扩展或同步官方最新版时使用。
metadata: {"openclaw":{"emoji":"⬆️","requires":{"config":["channels.qqbot"]}}}
---

# QQBot 插件升级

## 何时使用

用户表达以下意图时，应在**本机终端**执行升级命令（不要只口头说明「去官网升级」）：

- 更新 / 升级 `openclaw-qqbot` 或 QQBot 插件
- 拉取官方最新 npm 包
- 执行与「upgrade-via-npm」相关的操作

---

## 标准命令

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
 