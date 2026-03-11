# 更新日志

本文件记录项目的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [1.5.6] - 2026-03-10

### 新增

- 新增语音输入汇总日志，包含 STT/ASR/fallback 来源计数和 ASR 文本预览，便于调试语音处理链路。
- 新增 `asr_refer_text` 兜底支持——当 STT 未配置或转写失败时，使用 QQ 平台内置 ASR 文本作为低置信度兜底。
- 向 agent 上下文传递语音相关元数据（`QQVoiceAsrReferTexts`、`QQVoiceTranscriptSources`、`QQVoiceInputStrategy` 等）。
- README 新增定时提醒（主动消息）功能说明及演示截图。
- 统一 `appId` 解析逻辑，同时支持数值和字符串类型（涵盖运行时和主动消息脚本）。

### 修复

- 修复语音 prompt 提示，区分 STT 已配置/未配置状态，并增加 ASR 兜底和语音转发引导说明。

## [1.5.5] - 2026-03-09

### 新增

- 新增 `npm-upgrade.sh` 脚本，支持通过 npm 包安装和升级插件。
  - 支持 `--tag` 和 `--version` 选项，默认安装 `@alpha`。
  - 自动处理通道配置备份/恢复、旧插件清理（包括 `qqbot`、`@sliverp/qqbot`、`openclaw-qq` 等历史版本）、网关重启。
  - 安装前临时移除 `channels.qqbot` 配置，避免 `unknown channel id` 校验错误。

### 修复

- 修复插件 ID 与包名不一致导致插件加载失败的问题。
- 修复 `normalizeTarget` 返回类型——现在返回结构化的 `{ok, to, error}` 对象。
- 修复 `pull-latest.sh` 和 `upgrade.sh` 中过时的仓库 URL 引用。
- 修复 `proactive-api-server.ts` / `send-proactive.ts` 中硬编码的配置文件路径。
- 修复 `set-markdown.sh` 的 `read` 命令缺少超时参数，在非交互式环境下导致挂起的问题。

### 改进

- 脚本现已完全兼容多种 CLI（openclaw / clawdbot / moltbot），支持自动检测配置文件路径。
- `upgrade-and-run.sh` 首次运行时若缺少 AppID/Secret，现在会显示清晰的提示。
- `upgrade-and-run.sh` 升级前后现在会显示 qqbot 插件版本号。

## [1.5.4] - 2026-03-08

### 修复

- 修复多账户并发模式下的 Token 冲突——将全局 Token 缓存从单一变量重构为按 `appId` 隔离的 `Map`，解决多机器人同时运行时的 `11255 invalid request` 错误。
- 按实例独立刷新后台 Token——`clearTokenCache()` 和 `stopBackgroundTokenRefresh()` 现在接受 `appId` 参数，实现各账户独立管理。
- 修复非默认账户使用 `openclaw message send` 发送失败的问题——不指定 `--account` 时 `accountId` 始终回退到 `"default"`，导致向其他机器人的 OpenID 发消息时返回 500 错误。

### 新增

- 多账户配置文档——在 README 中新增"多账户配置"章节。
- 增强调试日志——`channel.ts` 中的日志添加 `[qqbot:channel]` 前缀，覆盖账户解析、消息发送和网关启动流程。
- API 日志前缀——所有 API 请求日志现在包含 `[qqbot-api:${appId}]` 前缀，方便多实例调试。

## [1.5.3] - 2026-03-06

### 修复

- 优化富媒体标签解析逻辑，提高识别成功率。
- 修复文件编码和特殊路径处理问题导致无法发送文件的问题。
- 修复消息 seq 号重复导致的间歇性消息丢失问题。

### 改进

- 升级脚本现在会在升级过程中自动备份和恢复 qqbot 通道配置。
- 更新 README，添加富媒体使用说明和插件配置/升级教程。

## [1.5.2] - 2026-03-05

### 新增

- 语音/文件发送能力，支持 TTS 文字转语音。
- 富媒体增强：上传缓存、视频支持、失败自动重试。
- 默认启用 Markdown 消息格式。
- 独立升级脚本，支持用户选择前台/后台启动。
