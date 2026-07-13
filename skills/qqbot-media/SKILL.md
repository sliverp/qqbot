---
name: qqbot-media
description: QQBot rich-media send/receive and MiniMax image generation. Use <qqmedia> tags; media types are detected from file extensions.
metadata: {"openclaw":{"emoji":"📸","requires":{"config":["channels.qqbot"]}}}
---

# QQBot 富媒体收发

## 用法

```
<qqmedia>路径或URL</qqmedia>
```

系统根据文件扩展名自动识别类型并路由：
- `.jpg/.png/.gif/.webp/.bmp` → 图片
- `.silk/.wav/.mp3/.ogg/.aac/.flac` 等 → 语音
- `.mp4/.mov/.avi/.mkv/.webm` 等 → 视频
- 其他扩展名 → 文件
- 无扩展名的 URL → 默认按图片处理

## 接收媒体

- 用户发来的**图片**自动下载到本地，路径在上下文【附件】中，可直接用 `<qqmedia>路径</qqmedia>` 回发
- 用户发来的**语音**路径在上下文中；若有 STT 能力则优先转写

## MiniMax image generation

When a user asks to generate or edit an image, use OpenClaw's `image_generate` tool instead of calling a provider HTTP API directly:

1. If `image_generate` is unavailable, tell the user that image generation is not enabled. Do not claim that an image was generated.
2. Call `image_generate` with `action=list` and select a listed MiniMax model: `minimax/*` for API-key auth or `minimax-portal/*` for OAuth. Do not guess model IDs. If no MiniMax entry is listed, ask the user to configure a MiniMax image-generation provider.
3. Call `action=generate` once with the user's prompt. For edits, pass the local image path from the current attachment context as `image`.
4. Image generation runs asynchronously in chat sessions. Wait for the completion event and let its attachment use the normal QQ delivery path; do not call `image_generate` again or wrap the same result in `<qqmedia>`.

## 规则

1. **路径必须是绝对路径**（以 `/` 或 `http` 开头）
2. **标签必须用开闭标签包裹路径**：`<qqmedia>路径</qqmedia>`
3. **你有能力发送本地图片/文件**——直接用标签包裹路径即可，**不要说"无法发送"**
4. 发送语音时不要重复语音中已朗读的文字
5. 多个媒体用多个标签
6. 以会话上下文中的能力说明为准（如未启用语音则不要发语音）
7. **发送前需检查文件大小**，当文件超限时告知用户文件太大，QQBot 发送文件大小规则如下：
   - 图片：最大 **30MB**
   - 语音：最大 **20MB**
   - 视频：最大 **100MB**
   - 文件：最大 **100MB**

## 示例

```
这是你要的图片：
<qqmedia>/Users/xxx/photo.jpg</qqmedia>
```

```
<qqmedia>/tmp/tts/output.mp3</qqmedia>
```

```
视频在这里：
<qqmedia>https://example.com/video.mp4</qqmedia>
```

```
文件已准备好：
<qqmedia>/tmp/report.pdf</qqmedia>
```
