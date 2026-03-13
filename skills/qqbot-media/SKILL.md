---
name: qqbot-media
description: QQBot 图片/语音/视频/文件收发能力。在回复中使用 <qqimg>/<qqvoice>/<qqvideo>/<qqfile> 标签即可发送富媒体，系统自动处理上传。当通过 QQ 通道通信时使用此技能。
metadata: {"openclaw":{"emoji":"📸","requires":{"config":["channels.qqbot"]}}}
---

# QQBot 富媒体收发

## 标签格式

| 类型 | 标签 | 来源 |
|------|------|------|
| 图片 | `<qqimg>路径或URL</qqimg>` | 本地绝对路径 / HTTP URL |
| 语音 | `<qqvoice>音频路径</qqvoice>` | 本地 .silk/.wav/.mp3/.ogg 等 |
| 视频 | `<qqvideo>路径或URL</qqvideo>` | 本地路径 / HTTP URL |
| 文件 | `<qqfile>路径或URL</qqfile>` | 本地路径 / HTTP URL |

标签直接写在回复文本中，系统自动解析、上传和发送。标签外的文字作为正文一起投递。

## 接收媒体

- 用户发来的**图片**自动下载到本地，路径在上下文【附件】中，可直接用 `<qqimg>路径</qqimg>` 回发
- 用户发来的**语音**路径在上下文中；若有 STT 能力则优先转写，否则用平台 `asr_refer_text` 作参考

## 规则

1. **路径必须是绝对路径**（以 `/` 或 `http` 开头）
2. **标签必须闭合**：`<qqimg>...</qqimg>`，不能漏掉开头或结尾
3. **文件大小上限 20MB**
4. **你有能力发送本地图片/文件**——直接用标签包裹路径即可，**不要说"无法发送"**
5. 发送语音时不要重复语音中已朗读的文字
6. 多个媒体用多个标签
7. 以会话上下文中的能力说明为准（如未启用语音则不要发语音）

## 示例

```
这是你要的图片：
<qqimg>/Users/xxx/photo.jpg</qqimg>
```

```
<qqvoice>/tmp/tts/output.mp3</qqvoice>
```

```
视频在这里：
<qqvideo>https://example.com/video.mp4</qqvideo>
```

```
文件已准备好：
<qqfile>/tmp/report.pdf</qqfile>
```
