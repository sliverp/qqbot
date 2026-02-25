# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
# Install dependencies
npm install

# Build (TypeScript to dist/)
npm run build

# Watch mode
npm run dev
```

## Plugin Management

```bash
# Install from local directory
openclaw plugins install .

# Upgrade
openclaw plugins upgrade @sliverp/qqbot@latest

# Enable/Disable
openclaw plugins enable qqbot
openclaw plugins disable qqbot
```

## Configuration

QQBot is configured via `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "your-app-id",
      "clientSecret": "your-secret"
    }
  }
}
```

Or via CLI:
```bash
openclaw config set channels.qqbot.appId "your-app-id"
openclaw config set channels.qqbot.clientSecret "your-secret"
```

### SOCKS5 Proxy (Fork Feature)

This fork (`corrinehu/qqbot`) adds SOCKS5 proxy support for API requests.

To use:

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "your-app-id",
      "clientSecret": "your-secret",
      "proxyUrl": "socks5h://100.67.244.78:1080"
    }
  }
}
```

- Use `socks5h://` for DNS resolution through proxy (recommended)
- Use `socks5://` for local DNS resolution
- See `docs/SOCKS_PROXY_FIX.md` for details

## Architecture

### Entry Point
- `index.ts` - Plugin definition, exports `qqbotPlugin` as the main channel plugin

### Core Modules
- `src/channel.ts` - Channel plugin implementation (messaging, config, gateway, status)
- `src/gateway.ts` - WebSocket gateway connection, QQ Bot API integration
- `src/config.ts` - Account configuration resolution (supports multi-account via `accounts` object)
- `src/outbound.ts` - Outbound message sending (text, media, proactive messages)
- `src/api.ts` - QQ Bot REST API wrapper (token management, message APIs)

### Message Flow
1. **Inbound**: WebSocket events → `gateway.ts` → parse payload → AI session
2. **Outbound**: AI response → `outbound.ts` → QQ Bot API

### Key Patterns
- **Multi-account support**: Top-level config for default account, `accounts` object for named accounts
- **Token caching**: Access token cached with auto-refresh (5min before expiry)
- **Message rate limiting**: Same message_id limited to 4 replies within 1 hour
- **Proactive vs Reactive**: Messages without `replyToId` use proactive API (monthly quota)

### Skills
- `skills/qqbot-cron/` - Reminder/scheduling skill using cron jobs
- `skills/qqbot-media/` - Media sending with `<qqimg>` tag support

## Testing

```bash
# Run CLI test
node bin/qqbot-cli.js --help

# Send test message
node bin/qqbot-cli.js --to openid --message "test"
```

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Plugin entry, exports |
| `src/types.ts` | TypeScript types (events, config, attachments) |
| `src/session-store.ts` | Session state persistence |
| `src/known-users.ts` | Known user tracking |
| `src/image-server.ts` | Local image server for file sharing |
| `scripts/` | Upgrade and proactive message scripts |

## Dependencies

- `ws` - WebSocket client
- `silk-wasm` - Voice message conversion (Silk format used by QQ)
