# 更新日志

本文件记录项目的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [1.6.2] - 2026-03-18

### 变更

- **Markdown 感知文本分块**：使用 SDK 内置 `chunkMarkdownText` 替代自定义分块函数，支持代码块自动关闭/重开、括号感知等。
- **启用块流式（blockStreaming）**：设置 `blockStreaming: true`，框架收集流式响应后通过 `deliver` 回调统一发送。
- **降低文本分块上限**：`textChunkLimit` 从 20000 调整为 5000，提升消息可读性。
- **静默媒体发送错误**：图片/语音/视频/文件发送失败时仅写日志，不再向用户展示错误提示，对齐飞书插件设计。

### 改进

- **引用内容不再截断**：移除存储引用消息时的 `MAX_CONTENT_LENGTH` 截断，保留完整消息原文。

### 移除

- 移除 `user-messages.ts` 中的 `MSG` 常量和 `formatMediaErrorMessage` 函数——插件层不再生成面向用户的错误提示。

## [1.6.1] - 2026-03-18

### 改进

- **升级脚本自动重启**：`upgrade-via-npm.sh` 升级完成后自动重启网关，使新版本立即生效。
- **提高文本分块上限**：`textChunkLimit` 从 2000 提升至 20000，允许更长的消息不被拆分发送。
- **移除主动推送更新通知**：不再在检测到新版本时主动推送通知给管理员，版本信息仅通过 `/bot-version` 和 `/bot-upgrade` 指令被动查询，减少消息打扰。

### 移除

- 移除 `update-checker.ts` 中的 `onUpdateFound` 回调和 `formatUpdateNotice` 辅助函数（主动推送移除后不再需要）。

## [1.6.0] - 2026-03-16

### 新增

- **斜杠指令体系**：新增 `/bot-ping`、`/bot-version`、`/bot-help`、`/bot-upgrade`、`/bot-logs` 五个插件级指令。
- **版本检查**：后台定时检查 npm 最新版本，`/bot-version` 展示更新状态，`/bot-upgrade` 提供升级指引。
- **启动问候语**：区分首次安装与普通重启，发送不同问候语。
- **日志下载**：`/bot-logs` 打包最近 2000 行日志发送文件给用户。

### 变更

- **统一富媒体标签**：将 `<qqimg>`、`<qqvoice>`、`<qqfile>`、`<qqvideo>` 统一为 `<qqmedia>` 标签，系统根据文件扩展名自动识别媒体类型。

### 改进

- **问候语防抖**：60s 内重复重启不再重复发送问候语（解决升级过程中刷屏问题）。
- **主动消息 48h 过滤**：发送启动问候前过滤超过 48h 未交互的用户，减少无效 500 错误。
- **Token 缓存刷新阈值**：从硬编码 5 分钟改为 `min(5min, remaining/3)`，修复短有效期 token 缓存失效导致每分钟重复请求的问题。
- **精简上下文注入**：优化注入给 OpenClaw 的上下文信息，减少冗余内容，降低 token 消耗。

## [1.5.7] - 2026-03-12

### 新增

- 新增 QQ `REFIDX_*` 引用消息上下文链路：从入站事件解析引用索引，缓存入站/出站消息摘要，并将引用内容注入 agent 上下文。
- 新增引用索引持久化存储（`~/.openclaw/qqbot/data/ref-index.jsonl`）：采用内存缓存 + JSONL 追加写，支持重启恢复、7 天 TTL 淘汰与 compact 压缩。
- 新增结构化引用附件摘要（图片/语音/视频/文件、local path/url、语音转录来源），提升引用回复语义完整性。

### 改进

- 机器人回复在可用时自动挂载对当前用户消息的引用，提升 QQ 会话串联可读性。

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
  - 自动处理通道配置备份/恢复、旧插件清理（包括 `qqbot`、`@sliverp/qqbot`、`openclaw-qqbot`、"@tencent-connect/openclaw-qqbot" 等历史版本）、网关重启。
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
