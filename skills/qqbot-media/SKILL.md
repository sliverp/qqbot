---
name: qqbot-media
description: QQBot 富媒体收发与 MiniMax 图片生成能力。使用 <qqmedia> 标签，系统根据文件扩展名自动识别类型（图片/语音/视频/文件）。
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

## MiniMax 图片生成

当用户要求生成或编辑图片时，使用 OpenClaw 的 `image_generate` 工具，不要直接请求 provider HTTP API：

1. 先用 `action=list` 查看当前可用的 provider 和模型。
2. 选择列表中返回的 `minimax/*` 模型；不要猜测或编造模型 ID。
3. 用 `action=generate` 传入用户的 prompt；编辑图片时，将上下文中的本地图片路径作为 `image` 传入。
4. `image_generate` 已投递生成结果时不要重复发送；如果它只返回了未投递的本地绝对路径，再用 `<qqmedia>绝对路径</qqmedia>` 发给用户。
5. 如果工具不可用或列表中没有 MiniMax provider，明确告知用户需要先完成 OpenClaw 的 MiniMax provider 配置；不要声称已生成图片。

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
