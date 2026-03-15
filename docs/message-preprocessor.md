# Message Preprocessor API

This document describes the message preprocessor feature added to the qqbot gateway.

## Overview

The message preprocessor provides a "fast lane" for messages that need immediate processing, bypassing the per-user serial message queue.

## The Problem It Solves

### Deadlock Scenario

When a plugin (like `sudo-control`) needs user approval before executing a command:

```
User sends: "execute sudo ls /root"
    → Message enters queue
    → AI processes it
    → Plugin sends approval request via QQ
    → Plugin awaits response (Promise pending)
    → User's queue is now blocked

User replies: "批准 sudo-xxx"
    → Message enters queue
    → BUT: Previous message is still being processed
    → Queue waits for previous message to complete
    → Previous message is waiting for user reply
    → DEADLOCK → Timeout after 5 minutes
```

### The Solution

Preprocessors run **before** messages enter the queue, allowing approval responses to resolve the pending Promise immediately:

```
User replies: "批准 sudo-xxx"
    → Preprocessor matches the pattern
    → Directly resolves the Promise
    → Returns true (message handled, don't enqueue)
    → No deadlock!
```

## API

### Types

```typescript
// Message structure passed to preprocessors
export interface QueuedMessage {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string }>;
  refMsgIdx?: string;
  msgIdx?: string;
}

// Preprocessor function signature
export type MessagePreprocessor = (msg: QueuedMessage) => boolean;
```

### Functions

#### `registerMessagePreprocessor(fn: MessagePreprocessor): () => void`

Registers a message preprocessor. Returns an unregister function.

**Parameters:**
- `fn` - Preprocessor function that receives the message
  - Returns `true` to intercept the message (don't enqueue)
  - Returns `false` to continue normal processing

**Returns:**
- Unregister function

### Usage Example

```typescript
import { registerMessagePreprocessor, type QueuedMessage } from './gateway.js';

// Register preprocessor
const unregister = registerMessagePreprocessor((msg: QueuedMessage) => {
  const content = msg.content.trim();

  // Handle approval responses
  if (content.startsWith('批准 sudo-')) {
    const requestId = content.split(' ')[1];
    resolveApproval(requestId, true);
    return true; // Message handled, don't enqueue
  }

  if (content.startsWith('拒绝 sudo-')) {
    const requestId = content.split(' ')[1];
    resolveApproval(requestId, false);
    return true;
  }

  return false; // Continue normal processing
});

// Later: unregister if no longer needed
unregister();
```

## Other Use Cases

| Use Case | Description |
|----------|-------------|
| **Emergency Stop** | `/abort` command to immediately cancel operations |
| **Quick Status** | `/ping`, `/uptime` for instant responses without AI |
| **Background Commands** | `>>backup` to trigger actions without interrupting chat |
| **Message Filtering** | Block spam or blacklist users before processing |
| **2FA Verification** | Handle verification codes without queuing |
| **Message Routing** | Route to different agents based on prefix |

## Design Principles

1. **Sync Only** - Preprocessors must be synchronous and fast
2. **No Blocking** - Avoid heavy operations that could block WebSocket heartbeat
3. **Error Handling** - Errors are caught and logged, processing continues
4. **Shared Scope** - Preprocessors are shared across all accounts

## Performance Impact

- **Empty preprocessor list**: Zero overhead (empty array iteration)
- **With preprocessors**: Minimal overhead (one function call per message)
- **Preprocessor errors**: Caught and logged, message continues to queue

## Migration Guide

For plugin authors who want to use this feature:

1. Import the gateway module:
   ```typescript
   const gateway = await import('path/to/qqbot/src/gateway.js');
   ```

2. Check if the feature is available:
   ```typescript
   if (typeof gateway.registerMessagePreprocessor === 'function') {
     // Feature available
   }
   ```

3. Register your preprocessor during plugin initialization

## Changelog

- **v1.7.0**: Added `registerMessagePreprocessor()` API
- **v1.7.0**: Exported `QueuedMessage` interface
