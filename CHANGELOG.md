# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [1.6.6] - 2026-03-25

### Added

- **Streaming messages (C2C)**: New `StreamingController` delivers AI responses as real-time typing-effect chunks in private chat. Includes throttle control (default 500ms, min 300ms), automatic media-tag pause/resume, long-gap batch window, state-machine lifecycle (`idle → streaming → completed/aborted`), and graceful fallback to static mode when the streaming API is unavailable.
- **Stream message API `sendC2CStreamMessage`**: Low-level wrapper for QQ Open Platform `/v2/users/{openid}/stream_messages` endpoint, with `replace` input mode, incremental `msg_seq`/`index`, and `GENERATING`/`DONE` state signaling.
- **`ApiError` structured error class**: API request errors now carry `status` (HTTP code) and `path`, enabling callers (e.g. streaming controller) to branch on status for retry vs. fallback decisions.
- **Media send queue module `media-send.ts`**: Extracted media-tag parsing, path-encoding fix, and send-queue execution into a shared utility used by both `outbound.ts` (static mode) and `streaming.ts` (streaming mode), eliminating ~100 lines of duplication.
- **Streaming configuration**: New `streaming` (boolean, default `false`) option in account config for per-account streaming control. Set `streaming: true` to enable.
- **Unit tests**: Added `strip-incomplete-media-tag.test.ts` and `streaming-controller.test.ts`.

### Changed

- **Outbound media handling refactored**: `sendText` in `outbound.ts` now delegates media-tag parsing and queue execution to the shared `media-send.ts` module instead of inline regex + switch logic.
- **Audio convert log level**: Downgraded `console.log` → `console.debug` for SILK detection, ffmpeg conversion, and WASM fallback logs in `audio-convert.ts`, reducing noise in production.
- **Gateway streaming integration**: `gateway.ts` creates a `StreamingController` per inbound message when streaming is enabled; registers `onPartialReply` callback to feed incremental text into the controller; finalizes or aborts the stream after dispatch completes.

### Removed

- **`user-messages.ts`**: Deleted the already-emptied module (design: plugin layer does not generate user-facing error text).

## [1.6.5] - 2026-03-24

### OpenClaw 3.23 Compatibility

OpenClaw 3.23 introduced strict config validation at CLI startup — any `openclaw` subcommand (including `plugins install`, `plugins update`, `gateway stop`) now validates the entire `openclaw.json` before execution. Since `channels.qqbot` is registered by this plugin (not a built-in channel id), running these commands when the plugin is not yet loaded causes `"Config invalid: unknown channel id: qqbot"` and the command fails entirely (chicken-and-egg problem).

This release adapts all upgrade paths for 3.23+:

- **Config stash/restore for CLI commands**: `upgrade-via-npm.sh` and `upgrade-via-source.sh` temporarily remove `channels.qqbot` from `openclaw.json` before running any openclaw CLI command, then restore it after completion.
- **Gateway pre-stop before install**: `upgrade-via-source.sh` now stops the gateway before `plugins install` to prevent chokidar from triggering a restart on the intermediate config state (with `channels.qqbot` removed), which would also hit the validation error.

### Fixed

- **Startup greeting marker path**: Fixed marker directory to use `$CMD` variable instead of hardcoded path, supporting multi-CLI environments.

### Changed

- **Silence non-upgrade startup greeting**: Startup greeting is now suppressed unless triggered by a `/bot-upgrade` hot update, reducing noise during routine gateway restarts.

## [1.6.4] - 2026-03-20

### Added

- **One-click hot upgrade `/bot-upgrade`**: Upgrade the plugin directly from private chat — no server login needed. Supports `--latest` (upgrade to latest), `--version X` (specific version), and `--force` (force reinstall). Version existence is verified against npm before proceeding.
- **Channel API proxy tool `qqbot_channel_api`**: AI can call QQ Open Platform channel HTTP APIs directly with automatic Token authentication and SSRF protection. Supports guild/channel management, member queries, forum threads, announcements, schedules, and more.
- **Credential backup protection**: New `credential-backup.ts` module auto-saves `appId`/`clientSecret` to a standalone file before hot upgrade. `isConfigured` now falls back to backup check — if config is lost but backup exists, the account still starts and credentials are auto-restored.
- **Command usage help**: All slash commands support `?` suffix to show detailed usage (e.g. `/bot-upgrade ?`).

### Changed

- **Real-time version check**: `getUpdateInfo()` changed from synchronous cache to `async` live npm registry query — every `/bot-version` or `/bot-upgrade` call fetches the latest data.
- **`/bot-logs` multi-source aggregation**: Long logs are auto-truncated with explanation.

### Improved

- **`switchPluginSourceToNpm` post-write validation**: Verifies `channels.qqbot` data integrity before writing back to `openclaw.json`, preventing race-condition credential loss.
- **Upgrade scripts with credential backup**: `upgrade-via-npm.sh` and `upgrade-via-source.sh` now save credential snapshots before upgrading.

## [1.6.3] - 2026-03-18

### Changed

- **Update checker: HTTPS-native with multi-registry fallback**: Replaced `npm view` CLI call with direct HTTPS requests to npm registry API; supports automatic fallback from npmjs.org to npmmirror.com, solving network issues in mainland China.
- **Upgrade script multi-registry fallback**: `upgrade-via-npm.sh` now tries npmjs.org → npmmirror.com → default registry in sequence, improving upgrade reliability in restricted networks.

## [1.6.2] - 2026-03-18

### Changed

- **Markdown-aware text chunking**: Replaced custom `chunkText` with SDK built-in `chunkMarkdownText`, supporting auto code-fence close/reopen, bracket awareness, etc.
- **Enable block streaming**: Set `blockStreaming: true` — the framework now collects streamed responses and delivers via the `deliver` callback.
- **Reduce text chunk limit**: `textChunkLimit` lowered from 20000 to 5000 for better message readability.
- **Silent media errors**: Media send failures (image/voice/video/file) are now logged only; error messages are no longer surfaced to the user.

### Improved

- **Ref-index content untruncated**: Removed `MAX_CONTENT_LENGTH` cap when storing quoted-message content, preserving full message body in ref-index store.

### Removed

- `MSG` constants and `formatMediaErrorMessage` from `user-messages.ts` — plugin layer no longer generates user-facing error text.

## [1.6.1] - 2026-03-18

### Improved

- **Upgrade script auto-restart**: `upgrade-via-npm.sh` now automatically restarts the gateway after upgrade to apply the new version immediately.
- **Increase text chunk limit**: Raised `textChunkLimit` from 2000 to 20000, allowing longer messages to be sent without splitting.
- **Remove proactive update push**: Removed the auto-push notification to admin when a new version is detected; version info is now only available passively via `/bot-version` and `/bot-upgrade` commands, reducing noise.

### Removed

- `onUpdateFound` callback and `formatUpdateNotice` helper from `update-checker.ts` — no longer needed after removing proactive push.

## [1.6.0] - 2026-03-16

### Added

- **Slash command system**: `/bot-ping`, `/bot-version`, `/bot-help`, `/bot-upgrade`, `/bot-logs` — five plugin-level slash commands.
- **Update checker**: Background npm version check with update status in `/bot-version` and upgrade guide in `/bot-upgrade`.
- **Startup greeting**: Distinguish first install vs. restart with different greeting messages.
- **Log download**: `/bot-logs` packages the last 2000 lines of logs and sends as a file.

### Changed

- **Unified rich media tag**: Replaced `<qqimg>`, `<qqvoice>`, `<qqfile>`, `<qqvideo>` with a single `<qqmedia>` tag — the system auto-detects media type by file extension.

### Improved

- **Greeting debounce**: Suppress duplicate greetings within 60s during rapid restarts (e.g. upgrades).
- **Proactive message 48h filter**: Skip users inactive for 48h+ when sending startup greetings, reducing 500 errors.
- **Token cache refresh threshold**: Changed from hardcoded 5-minute early refresh to `min(5min, remaining/3)`, fixing repeated token requests when API returns short-lived tokens.
- **Streamlined context injection**: Reduced redundant context injected into OpenClaw, lowering token consumption.

## [1.5.7] - 2026-03-12

### Added

- Add quoted-message context pipeline for QQ `REFIDX_*`: parse quote indices from inbound events, cache inbound/outbound message summaries, and inject quote body into agent context.
- Add persistent quote index store (`~/.openclaw/qqbot/data/ref-index.jsonl`) with in-memory cache + JSONL append, restart recovery, 7-day TTL eviction, and compact.
- Add structured quote attachment summaries (image/voice/video/file, local path/url, voice transcript source) for better reply grounding.

### Improved

- Bot replies now attach quote reference to the user's current message when available, improving threaded conversation readability in QQ.

## [1.5.6] - 2026-03-10

### Added

- Add voice input summary log with STT/ASR/fallback source counters and ASR text preview for debugging voice pipeline.
- Add `asr_refer_text` fallback support — when STT is not configured or fails, use QQ platform's built-in ASR text as low-confidence fallback.
- Pass voice-related metadata (`QQVoiceAsrReferTexts`, `QQVoiceTranscriptSources`, `QQVoiceInputStrategy`, etc.) to agent context.
- Add scheduled reminder (proactive message) section to README with demo screenshot.
- Normalize `appId` parsing to support both numeric and string values across runtime and proactive scripts.

### Fixed

- Fix voice prompt hints to distinguish STT-configured vs. unconfigured states and add ASR fallback / voice forward guidance.

## [1.5.5] - 2026-03-09

### Added

- Add `npm-upgrade.sh` script for npm-based plugin installation and upgrade.
  - Supports `--tag` and `--version` options, defaults to `@alpha`.
  - Handles channel config backup/restore, old plugin cleanup (including legacy variants like `qqbot`, `@sliverp/qqbot`), and gateway restart.
  - Temporarily removes `channels.qqbot` before install to avoid `unknown channel id` validation error.

### Fixed

- Fix plugin id not matching package name, causing plugin load failure.
- Fix `normalizeTarget` return type — now returns structured `{ok, to, error}` object.
- Fix outdated repo URL references in `pull-latest.sh` and `upgrade.sh`.
- Fix `proactive-api-server.ts` / `send-proactive.ts` hardcoded config file paths.
- Fix `set-markdown.sh` `read` missing timeout causing hang in non-interactive environments.

### Improved

- Scripts now fully compatible with multiple CLIs (openclaw / clawdbot / moltbot) with auto-detection of config file paths.
- `upgrade-and-run.sh` now shows clear prompt when AppID/Secret is missing on first run.
- `upgrade-and-run.sh` now displays qqbot plugin version before and after upgrade.

## [1.5.4] - 2026-03-08

### Fixed

- Fix Token collision in multi-account concurrent mode — refactored global Token cache from a single variable to a per-`appId` `Map`, resolving `11255 invalid request` errors when multiple bots run simultaneously.
- Per-instance background Token refresh — `clearTokenCache()` and `stopBackgroundTokenRefresh()` now accept an `appId` parameter for independent per-account management.
- Fix `openclaw message send` failing for non-default accounts — without `--account`, `accountId` always fell back to `"default"`, causing a 500 error when sending to an OpenID belonging to a different bot.

### Added

- Multi-account documentation — added "Multi-Account Setup" section to README.
- Enhanced debug logging — `[qqbot:channel]` prefixed logs in `channel.ts`, covering account resolution, message sending, and gateway startup.
- API log prefix — all API request logs now include `[qqbot-api:${appId}]` prefix for easier multi-instance debugging.

## [1.5.3] - 2026-03-06

### Fixed

- Improved rich media tag parsing logic for higher recognition success rate.
- Fixed file encoding issues and special path handling that prevented file sending.
- Fixed intermittent message loss caused by duplicate message seq numbers.

### Improved

- Upgrade script now auto-backs up and restores qqbot channel config during upgrades.
- Updated README with rich media usage instructions and plugin config/upgrade tutorial.

## [1.5.2] - 2026-03-05

### Added

- Voice/file sending capability with TTS text-to-speech support.
- Rich media enhancements: upload caching, video support, automatic retry on failure.
- Markdown messages enabled by default.
- Standalone upgrade script with user choice of foreground/background startup.
