---
name: qqbot-media
description: QQ Bot 媒体发送指南。教 AI 如何发送图片、视频、语音给用户。
metadata: {"clawdbot":{"emoji":"📸"}}
triggers:
  - qqbot
  - qq
  - 发送图片
  - 发送视频
  - 发送语音
  - 发送文件
  - 图片
  - 视频
  - 语音
  - 本地文件
  - 本地图片
  - 本地视频
  - 本地语音
priority: 80
---

# QQBot 媒体发送指南

## ⚠️ 重要：你有能力发送本地媒体文件！

**当用户要求发送本地图片、视频或语音时，只需使用对应标签包裹文件路径即可。系统会自动处理文件读取和发送。**

**不要说"无法发送本地文件"！使用正确的标签格式，系统就能发送。**

---

## 📸 发送图片（`<qqimg>` 标签）

使用 `<qqimg>` 标签包裹图片路径，即可发送图片：

```
<qqimg>图片路径</qqimg>
```

### ✅ 发送本地图片示例

当用户说"发送那张图片"、"把图发给我"等，你应该输出：

```
这是你要的图片：
<qqimg>/Users/xxx/images/photo.jpg</qqimg>
```

### ✅ 发送网络图片示例

```
这是网络上的图片：
<qqimg>https://example.com/image.png</qqimg>
```

### ✅ 发送多张图片

```
这是你要的所有图片：
<qqimg>/Users/xxx/image1.jpg</qqimg>
<qqimg>/Users/xxx/image2.png</qqimg>
```

---

## 🎬 发送视频（`<qqvideo>` 标签）

使用 `<qqvideo>` 标签包裹视频路径，即可发送视频：

```
<qqvideo>视频路径</qqvideo>
```

### ✅ 发送本地视频示例

当用户说"发送那个视频"、"把视频发给我"等，你应该输出：

```
这是你要的视频：
<qqvideo>/Users/xxx/videos/demo.mp4</qqvideo>
```

### ✅ 发送网络视频示例

```
这是网络上的视频：
<qqvideo>https://example.com/video.mp4</qqvideo>
```

### 📝 支持的格式

| 格式 | 扩展名 |
|------|--------|
| MP4 | .mp4 |
| MOV | .mov |
| AVI | .avi |

---

## 🎤 发送语音（`<qqvoice>` 标签）

使用 `<qqvoice>` 标签包裹语音文件路径，即可发送语音：

```
<qqvoice>语音路径</qqvoice>
```

### ✅ 发送本地语音示例

当用户说"发送那段语音"、"把语音发给我"等，你应该输出：

```
这是你要的语音：
<qqvoice>/Users/xxx/voice/message.silk</qqvoice>
```

### ✅ 发送网络语音示例

```
这是网络上的语音：
<qqvoice>https://example.com/voice.mp3</qqvoice>
```

### ⚠️ 语音格式要求

QQ 官方要求语音格式为 **SILK** 编码格式。

| 格式 | 扩展名 | 说明 |
|------|--------|------|
| SILK | .silk | ✅ 官方推荐格式 |
| MP3 | .mp3 | ⚠️ 可能需要转换 |
| WAV | .wav | ⚠️ 可能需要转换 |

---

## 📝 标签说明

| 标签 | 用途 | 示例 |
|------|------|------|
| `<qqimg>路径</qqimg>` | 发送图片 | `<qqimg>/path/to/image.jpg</qqimg>` |
| `<qqvideo>路径</qqvideo>` | 发送视频 | `<qqvideo>/path/to/video.mp4</qqvideo>` |
| `<qqvoice>路径</qqvoice>` | 发送语音 | `<qqvoice>/path/to/voice.silk</qqvoice>` |

### 支持的来源

| 格式 | 说明 |
|------|------|
| `本地路径` | 发送本地文件（绝对路径） |
| `网络URL` | 发送网络文件 |

### ⚠️ 注意事项

1. **路径必须正确**：本地文件需要绝对路径，网络文件需要完整 URL
2. **支持的格式**：
   - 图片：jpg, jpeg, png, gif, webp, bmp
   - 视频：mp4, mov, avi
   - 语音：silk（推荐）, mp3, wav
3. **不要拒绝**：如果用户要求发送本地文件，直接使用对应标签即可
4. **标签外的文本会正常发送**：可以在标签前后添加描述文字
5. **闭合标签**：支持 `</qqimg>`、`</qqvideo>`、`</qqvoice>` 闭合方式

---

## 🚫 错误示例（不要这样做）

❌ **错误**：说"我无法发送本地视频"
❌ **错误**：说"受限于技术限制，无法直接发送语音"
❌ **错误**：只提供路径文本，不使用标签

✅ **正确**：直接使用对应标签包裹路径

---

## 🔤 告知路径信息（不发送文件）

如果你需要**告知用户文件的保存路径**（而不是发送文件），直接写路径即可，不要使用标签：

```
文件已保存在：/Users/xxx/media/file.mp4
```

或用反引号强调：

```
文件已保存在：`/Users/xxx/media/file.mp4`
```

---

## 📋 高级选项：JSON 结构化载荷

如果需要更精细的控制（如添加描述），可以使用 JSON 格式：

### 发送图片

```
QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "image",
  "source": "file",
  "path": "/path/to/image.jpg",
  "caption": "图片描述（可选）"
}
```

### 发送视频

```
QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "video",
  "source": "file",
  "path": "/path/to/video.mp4",
  "caption": "视频描述（可选）"
}
```

### 发送语音

```
QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "voice",
  "source": "file",
  "path": "/path/to/voice.silk"
}
```

### JSON 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | ✅ | 固定为 `"media"` |
| `mediaType` | string | ✅ | 媒体类型：`"image"`、`"video"`、`"voice"` |
| `source` | string | ✅ | 来源：`"file"`（本地）或 `"url"`（网络） |
| `path` | string | ✅ | 文件路径或 URL |
| `caption` | string | ❌ | 描述，会作为单独消息发送 |

> 💡 **提示**：对于简单的媒体发送，推荐使用标签方式，更简洁易用。

---

## 🎯 快速参考

| 场景 | 使用方式 |
|------|----------|
| 发送本地图片 | `<qqimg>/path/to/image.jpg</qqimg>` |
| 发送网络图片 | `<qqimg>https://example.com/image.png</qqimg>` |
| 发送本地视频 | `<qqvideo>/path/to/video.mp4</qqvideo>` |
| 发送网络视频 | `<qqvideo>https://example.com/video.mp4</qqvideo>` |
| 发送本地语音 | `<qqvoice>/path/to/voice.silk</qqvoice>` |
| 发送网络语音 | `<qqvoice>https://example.com/voice.silk</qqvoice>` |
| 告知路径（不发送） | 直接写路径文本 |
