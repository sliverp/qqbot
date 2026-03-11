# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
  - Handles channel config backup/restore, old plugin cleanup (including legacy variants like `qqbot`, `@sliverp/qqbot`, `openclaw-qq`), and gateway restart.
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
