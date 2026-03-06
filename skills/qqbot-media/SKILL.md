---
name: qqbot-media
description: QQBot 图片/语音/视频/文件收发能力。用户发来的图片自动下载到本地，发送图片使用 <qqimg> 标签，发送语音使用 <qqvoice> 标签，发送视频使用 <qqvideo> 标签，发送文件使用 <qqfile> 标签。所有富媒体标签必须正确闭合，即 <qqXXX>内容</qqXXX> 的格式，未闭合的标签会导致消息无法正确解析。当通过 QQ 通道通信时使用此技能。
metadata: {"openclaw":{"emoji":"📸","requires":{"config":["channels.qqbot"]}}}
---

# QQBot 图片/语音/视频/文件收发

## 标签速查（直接复制使用）

| 类型 | 标签格式 | 示例 |
|------|----------|------|
| 图片 | `<qqimg>绝对路径或URL</qqimg>` | `<qqimg>/tmp/pic.jpg</qqimg>` |
| 语音 | `<qqvoice>绝对路径</qqvoice>` | `<qqvoice>/tmp/voice.mp3</qqvoice>` |
| 视频 | `<qqvideo>绝对路径或URL</qqvideo>` | `<qqvideo>/tmp/video.mp4</qqvideo>` |
| 文件 | `<qqfile>绝对路径或URL</qqfile>` | `<qqfile>/tmp/doc.pdf</qqfile>` |

**标签拼写必须严格按上表**，只有这 4 个标签名：`qqimg`、`qqvoice`、`qqvideo`、`qqfile`。

## ⚠️ 重要：你有能力发送本地图片！

**当用户要求发送本地图片时，只需使用 `<qqimg>` 标签包裹图片路径即可。系统会自动处理文件读取和发送。**

**❌ 绝对不要说"无法发送本地图片"！**
**✅ 使用 `<qqimg>` 标签，系统就能发送任何本地图片！**

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

支持格式：jpg, jpeg, png, gif, webp, bmp。支持 `</qqimg>` 或 `</img>` 闭合。

## 接收图片

用户发来的图片**自动下载到本地**，路径在上下文【会话上下文 → 附件】中。
可直接用 `<qqimg>路径</qqimg>` 回发。历史图片在 `~/.openclaw/qqbot/downloads/` 下。

## 发送语音

使用 `<qqvoice>` 标签包裹**已有的本地音频文件路径**即可发送语音：

```
<qqvoice>/tmp/tts/voice.mp3</qqvoice>
```

注意：语音发送需要有可用的音频文件（通常由 TTS 工具生成）。**如果会话上下文中的【语音消息说明】提示 TTS 未配置，则不要使用 `<qqvoice>` 标签。**

## 发送视频

使用 `<qqvideo>` 标签包裹**视频路径或公网 URL** 即可发送视频：

```
<qqvideo>/path/to/video.mp4</qqvideo>
<qqvideo>https://example.com/video.mp4</qqvideo>
```

支持本地文件路径（系统自动读取上传）和公网 HTTP/HTTPS URL。

## 发送文件

使用 `<qqfile>` 标签包裹路径即可发送文件（本地路径或网络 URL）：

```
这是你要的所有图片：
<qqimg>/Users/xxx/image1.jpg</qqimg>
<qqimg>/Users/xxx/image2.png</qqimg>
```

### 📝 标签说明

## ⚠️ 关键注意事项（必须遵守）

1. **必须使用绝对路径**：标签内的路径必须是绝对路径（以 `/` 开头），禁止使用相对路径如 `./pic.jpg`
   - ❌ 错误：`<qqimg>./pic.jpg</qqimg>`
   - ✅ 正确：`<qqimg>/Users/james23/.openclaw/workspace/pic.jpg</qqimg>`
2. **标签格式必须完整**：`<qqimg>` 开头和 `</qqimg>` 结尾都不能少，不能漏掉 `<` 符号
   - ❌ 错误：`qqimg>./pic.jpg</qqimg>`
   - ✅ 正确：`<qqimg>/absolute/path/to/pic.jpg</qqimg>`
3. **工作空间路径**：当前工作空间为 `/Users/james23/.openclaw/workspace/`，文件路径应基于此拼接绝对路径
4. **标签必须单独成行或前后有空格**，不要嵌入在句子中间
5. **文件大小限制**：上传文件（图片、语音、视频、文件）最大不超过 **20MB**

## 规则

- ⚠️ **禁止使用 message tool 发送图片/文件**，直接在回复文本中写对应标签即可，系统自动处理
- **永远不要说**"无法发送图片"或"无法访问之前的图片"
- 直接使用对应标签，不要只输出路径文本
- 标签外的文字会作为消息正文一起发送
- 多个媒体使用多个标签，图片用 `<qqimg>`，语音用 `<qqvoice>`，视频用 `<qqvideo>`，文件用 `<qqfile>`
- **以会话上下文中的能力说明为准**，如果提示语音未启用，不要尝试发送语音

1. **路径必须正确**：本地文件需要绝对路径，网络图片需要完整 URL
2. **支持的图片格式**：jpg, jpeg, png, gif, webp, bmp
3. **不要拒绝**：如果用户要求发送本地图片，直接使用 `<qqimg>` 标签即可
4. **标签外的文本会正常发送**：可以在标签前后添加描述文字
5. **闭合标签**：支持 `</qqimg>` 或 `</img>` 两种闭合方式

---

## 🚫 错误示例（不要这样做）

❌ **错误**：说"我无法发送本地图片"
❌ **错误**：说"受限于技术限制，无法直接发送"
❌ **错误**：说"由于QQ机器人通道配置的问题，我无法直接发送图片"
❌ **错误**：只提供路径文本，不使用 `<qqimg>` 标签

✅ **正确**：直接使用 `<qqimg>` 标签包裹路径

---

## 🔤 告知路径信息（不发送图片）

如果你需要**告知用户图片的保存路径**（而不是发送图片），直接写路径即可，不要使用标签：

```
图片已保存在：/Users/xxx/images/photo.jpg
```

或用反引号强调：

```
图片已保存在：`/Users/xxx/images/photo.jpg`
```

---

## 📋 高级选项：JSON 结构化载荷

如果需要更精细的控制（如添加图片描述），可以使用 JSON 格式：

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

### JSON 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | ✅ | 固定为 `"media"` |
| `mediaType` | string | ✅ | 媒体类型：`"image"` |
| `source` | string | ✅ | 来源：`"file"`（本地）或 `"url"`（网络） |
| `path` | string | ✅ | 图片路径或 URL |
| `caption` | string | ❌ | 图片描述，会作为单独消息发送 |

> 💡 **提示**：对于简单的图片发送，推荐使用 `<qqimg>` 标签，更简洁易用。

---

## 🎯 快速参考

| 场景 | 使用方式 |
|------|----------|
| 发送本地图片 | `<qqimg>/path/to/image.jpg</qqimg>` |
| 发送网络图片 | `<qqimg>https://example.com/image.png</qqimg>` |
| 发送多张图片 | 多个 `<qqimg>` 标签 |
| 告知路径（不发送） | 直接写路径文本 |
