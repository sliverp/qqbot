# OpenClaw QQ Bot 富媒体能力全解

纯文字的 AI 聊天就像只能发消息的朋友——能聊天，但少了点温度。

想象一下：你发一段语音它就能听懂，你丢一份文件它就能读完，它还能画图、发语音、传文件、甚至发视频给你——这才叫全能搭档。

OpenClaw QQ Bot 插件为此提供了富媒体收发支持，覆盖图片、语音、视频、文件的双向交互。下面来看看实际效果 👇


---

## AI 能接收什么

用户发给 AI 的不只是文字——语音、文件、图片都能被理解。

### 语音消息（STT）

用户发的语音消息也能被 AI "听懂"。配置 STT 后，插件会自动将语音转录为文字再交给 AI 处理。

STT 支持两级配置，按优先级查找：`channels.qqbot.stt`（插件专属） → `tools.media.audio.models[0]`（框架级回退）。以框架级配置为例：

```json
{
  "tools": {
    "media": {
      "audio": {
        "models": [
          { "provider": "openai", "model": "FunAudioLLM/SenseVoiceSmall" }
        ]
      }
    }
  }
}
```

`provider` 引用 `models.providers` 中的 key，自动继承 `baseUrl` 和 `apiKey`，支持任何 OpenAI 兼容的 STT 接口。也可在条目中直接写 `baseUrl` / `apiKey` 覆盖。

> **你**：（发送一段语音）"明天深圳天气怎么样"
>
> **QQBot**：明天（3月7日 周六）深圳的天气预报 🌤️ ...

整个过程对用户完全透明——发语音就像发文字一样自然，AI 听得懂你在说什么。


![听语音演示](images/fc7b2236896cfba3a37c94be5d59ce3e_720.jpg)

### 文件

用户发文件给 AI，AI 同样能接住。不管是一本小说还是一份报告，AI 会自动识别文件内容并给出智能回复：

> **你**：（发送《战争与和平》TXT 文件）
>
> **QQBot**：收到！你上传了列夫·托尔斯泰的《战争与和平》中文版文本。从内容来看，这是第一章的开头……你想让我做什么？

![AI理解用户发送的文件](images/07bff56ab68e03173d2af586eeb3bcee_720.jpg)

### 图片

如果主模型支持视觉（如腾讯混元 `hunyuan-vision`），用户发图片 AI 也能看懂。这是多模态模型的通用能力，非插件专属功能，主模型配置方式见 [README](../README.zh.md#步骤3-配置openclaw)。

> **你**：（发送一张图片）
>
> **QQBot**：哈哈，好可爱！这是QQ企鹅穿上小龙虾套装吗？🦞🐧 ...

![图片理解演示](images/59d421891f813b0d3c0cbe12574b6a72_720.jpg)

---

## AI 能发送什么

AI 的回复不只是文字——图片、语音、文件、视频都能直接发出来。

### 图片

AI 在回复中写 `<qqimg>` 标签，系统自动上传发送。用户说"画个猫咪"，AI 就能调用绘图工具生成图片，直接发到对话里：

> **你**：画一只猫咪
>
> **QQBot**：`<qqimg>~/.openclaw/qqbot/images/cute-cat.png</qqimg>`

本地文件路径和网络 URL 都行，支持 jpg/png/gif/webp/bmp。

![发图片演示](images/4645f2b3a20822b7f8d6664a708529eb_720.jpg)

### 语音（TTS）

配置 TTS 后，AI 可以把文字变成语音消息发出来。比如让它讲个笑话，回复直接就是一条语音。

TTS 同样支持两级配置：`channels.qqbot.tts`（插件专属） → `messages.tts`（框架级回退）。以插件专属配置为例：

```json
{
  "channels": {
    "qqbot": {
      "tts": { "provider": "openai", "model": "FunAudioLLM/CosyVoice2-0.5B", "voice": "FunAudioLLM/CosyVoice2-0.5B:claire" }
    }
  }
}
```

`provider` 引用 `models.providers` 中的 key，自动继承 `baseUrl` 和 `apiKey`。可通过 `voice` 选择音色，设置 `enabled: false` 可禁用。详细的多级配置说明见 [README](../README.zh.md#语音能力配置可选)。

> **你**：用语音讲个笑话
>
> **QQBot**：`<qqvoice>~/.openclaw/qqbot/tts/joke.silk</qqvoice>`

支持 mp3/wav/silk/ogg 等常见音频格式，未安装 ffmpeg 也可正常使用。

![发语音演示](images/21dce8bfc553ce23d1bd1b270e9c516c.jpg)

### 文件

> **你**：战争与和平的第一章截取一下发文件给我
>
> **QQBot**：`<qqfile>~/.openclaw/qqbot/downloads/战争与和平_第一章.txt</qqfile>`

PDF、Excel、ZIP、TXT，什么格式都能发，最大 20MB。

![发文件演示](images/17cada70df90185d45a2d6dd36e92f2f_720.jpg)

### 视频

> **你**：发一个演示视频给我
>
> **QQBot**：`<qqvideo>~/.openclaw/qqbot/downloads/demo.mp4</qqvideo>`

支持本地文件路径和公网 URL，大文件（>5MB）会自动提示"正在上传..."。

![发视频演示](images/85d03b8a216f267ab7b2aee248a18a41_720.jpg)

---

## 体验演示场景

以下是几个可以直接复现的玩法：

| 方向 | 你说 | AI 做 |
|------|------|-------|
| 接收语音 | 发送一段语音提问天气 | STT 自动转录，AI 理解后文字回复 |
| 接收文件 | 发送一个文件给机器人 | AI 识别文件内容，智能分析回复 |
| 发送图片 | "帮我画一只猫咪" | 调用绘图工具，生成图片发回 |
| 发送语音 | "用语音讲个笑话" | TTS 生成语音，直接发送语音消息 |
| 发送文件 | "帮我生成一个文件" | 生成文件并通过 `<qqfile>` 发送 |
| 发送视频 | "发个视频给我" | 通过 `<qqvideo>` 直接发送视频 |

---

## 为什么体验这么丝滑？

不是因为功能多，而是因为**细节做对了**：

- **标签容错**：`<qq_img>`、`<image>`、甚至中文尖括号 `＜qqimg＞` 等 30 多种变体写法均可自动纠正为标准标签
- **上传缓存**：相同文件短时间内发给同一目标，自动复用上次的上传结果，避免重复传输
- **有序发送**：一条消息里混着文字、图片、语音，系统自动拆解成队列按顺序发，某一项失败不影响其他
- **分层降级**：音频格式转换会自动尝试多种方式，确保语音正常送达

这些细节不会出现在功能列表里，但它们决定了实际使用时顺不顺手。

---

## 快速回顾

```
接收  语音 → STT 自动转录，用户发语音 AI 就能懂
      文件 → 自动下载识别内容
      图片 → 需主模型支持视觉（非插件功能）

发送  图片 → <qqimg> 标签，本地文件/URL 均可
      语音 → <qqvoice> 标签，TTS 合成或已有音频
      文件 → <qqfile> 标签，任意格式最大 20MB
      视频 → <qqvideo> 标签，本地文件/URL
```

配置 STT/TTS 后语音双向打通，其余能力开箱即用。
