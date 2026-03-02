---
name: qqbot-media
description: QQ Bot 媒体发送指南。教 AI 如何发送图片、视频、语音给用户。【重要】当用户要求发送媒体时必须使用对应标签。
metadata: {"clawdbot":{"emoji":"📸"}}
triggers:
  - qqbot
  - qq
  - 发送图片
  - 发送视频
  - 发送语音
  - 发送文件
  - 发图
  - 发给我
  - 给我发
  - 图片
  - 视频
  - 语音
  - 本地文件
  - 本地图片
  - 生成的图
  - 画的图
  - 那张图
  - 上面的图
  - 刚才的图
  - 之前的图
  - 这张图
  - 那个图
  - png
  - jpg
  - jpeg
  - gif
  - mp4
  - mov
  - mp3
  - wav
  - silk
  - 截图
  - 照片
priority: 90
---

# QQBot 媒体发送指南

## ⚠️ 重要：你有能力发送本地媒体文件！

**当用户要求发送本地图片、视频或语音时，只需使用对应标签包裹文件路径即可。系统会自动处理文件读取和发送。**

**❌ 绝对不要说"无法发送本地文件"！**
**✅ 使用 `<qqimg>` `<qqvideo>` `<qqvoice>` 标签，系统就能发送任何本地媒体文件！**

---

## 📸 发送图片（推荐方式：`<qqimg>` 标签）

使用 `<qqimg>` 标签包裹图片路径，即可发送图片：

```
<qqimg>图片路径</qqimg>
```

### ✅ 发送本地图片示例

当用户说"发送那张图片"、"把图发给我"、"发上面生成的图片"等，你应该直接输出：

```
这是你要的图片：
<qqimg>/Users/xxx/images/photo.jpg</qqimg>
```

### ✅ 发送之前生成/创建的图片

如果你之前生成了图片（比如绘图、截图等），并且知道图片路径，直接用 `<qqimg>` 发送：

```
好的，这是刚才生成的图片：
<qqimg>/Users/xxx/Pictures/openclaw-drawings/drawing_xxx.png</qqimg>
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

### 📝 图片标签说明

| 格式 | 说明 |
|------|------|
| `<qqimg>本地路径</qqimg>` | 发送本地图片（绝对路径） |
| `<qqimg>网络URL</qqimg>` | 发送网络图片 |
| `<qqimg>路径</img>` | 也支持此闭合方式 |

### ⚠️ 图片注意事项

1. **路径必须正确**：本地文件需要绝对路径，网络图片需要完整 URL
2. **支持的图片格式**：jpg, jpeg, png, gif, webp, bmp
3. **不要拒绝**：如果用户要求发送本地图片，直接使用 `<qqimg>` 标签即可
4. **标签外的文本会正常发送**：可以在标签前后添加描述文字
5. **闭合标签**：支持 `</qqimg>` 或 `</img>` 两种闭合方式

---

## 🎬 发送视频（`<qqvideo>` 标签）

使用 `<qqvideo>` 标签包裹视频路径，即可发送视频：

```
<qqvideo>视频路径</qqvideo>
```

### ✅ 发送本地视频示例

```
这是你要的视频：
<qqvideo>/Users/xxx/videos/demo.mp4</qqvideo>
```

### ✅ 发送网络视频示例

```
这是一个网络视频：
<qqvideo>https://example.com/video.mp4</qqvideo>
```

### 📝 视频标签说明

| 格式 | 说明 |
|------|------|
| `<qqvideo>本地路径</qqvideo>` | 发送本地视频（绝对路径） |
| `<qqvideo>网络URL</qqvideo>` | 发送网络视频 |
| `<qqvideo>路径</video>` | 也支持此闭合方式 |

### ⚠️ 视频注意事项

1. **支持的视频格式**：mp4, mov, avi
2. **频道不支持视频**：目前只有私聊和群聊支持视频消息
3. **闭合标签**：支持 `</qqvideo>` 或 `</video>` 两种闭合方式

---

## 🎤 发送语音（`<qqvoice>` 标签）

使用 `<qqvoice>` 标签包裹语音路径，即可发送语音：

```
<qqvoice>语音路径</qqvoice>
```

### ✅ 发送本地语音示例

```
这是一条语音消息：
<qqvoice>/Users/xxx/audio/voice.mp3</qqvoice>
```

### ✅ 发送网络语音示例

```
这是一个网络语音：
<qqvoice>https://example.com/voice.silk</qqvoice>
```

### 📝 语音标签说明

| 格式 | 说明 |
|------|------|
| `<qqvoice>本地路径</qqvoice>` | 发送本地语音（绝对路径） |
| `<qqvoice>网络URL</qqvoice>` | 发送网络语音 |
| `<qqvoice>路径</voice>` | 也支持此闭合方式 |

### ⚠️ 语音注意事项

1. **支持的语音格式**：mp3, wav, ogg, silk（系统会自动转换为 SILK 格式）
2. **需要 ffmpeg**：发送非 SILK 格式的语音需要系统安装 ffmpeg
3. **频道不支持语音**：目前只有私聊和群聊支持语音消息
4. **闭合标签**：支持 `</qqvoice>` 或 `</voice>` 两种闭合方式

---

## 🚫 错误示例（不要这样做）

❌ **错误**：说"我无法发送本地图片/视频/语音"
❌ **错误**：说"受限于技术限制，无法直接发送"
❌ **错误**：说"由于QQ机器人通道配置的问题，我无法直接发送"
❌ **错误**：只提供路径文本，不使用标签

✅ **正确**：直接使用对应标签包裹路径

---

## 🔤 告知路径信息（不发送文件）

如果你需要**告知用户文件的保存路径**（而不是发送文件），直接写路径即可，不要使用标签：

```
文件已保存在：/Users/xxx/images/photo.jpg
```

或用反引号强调：

```
文件已保存在：`/Users/xxx/images/photo.jpg`
```

---

## 📋 高级选项：JSON 结构化载荷

如果需要更精细的控制（如添加描述），可以使用 JSON 格式：

```
QQBOT_PAYLOAD:
{
  "type": "media",
  "mediaType": "image",
  "source": "file",
  "path": "/path/to/image.jpg",
  "caption": "描述（可选）"
}
```

### JSON 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | ✅ | 固定为 `"media"` |
| `mediaType` | string | ✅ | 媒体类型：`"image"`、`"video"` 或 `"voice"` |
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
| 发送本地语音 | `<qqvoice>/path/to/voice.mp3</qqvoice>` |
| 发送网络语音 | `<qqvoice>https://example.com/voice.silk</qqvoice>` |
| 发送多张图片 | 多个 `<qqimg>` 标签 |
| 告知路径（不发送） | 直接写路径文本 |
