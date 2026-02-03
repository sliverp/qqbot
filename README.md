# QQ Bot Channel Plugin for Moltbot

QQ 开放平台Bot API 的 Moltbot 渠道插件，支持 C2C 私聊、群聊 @消息、频道消息。

## 功能特性

- **多场景支持**：C2C 单聊、QQ 群 @消息、频道公开消息、频道私信
- **自动重连**：WebSocket 断连后自动重连，支持 Session Resume
- **消息去重**：自动管理 `msg_seq`，支持对同一消息多次回复
- **系统提示词**：可配置自定义系统提示词注入到 AI 请求
- **错误提示**：AI 无响应时自动提示用户检查配置

## 使用示例：
<img width="1852" height="1082" alt="image" src="https://github.com/user-attachments/assets/a16d582b-708c-473e-b3a2-e0c4c503a0c8" />

## 版本更新
<img width="1902" height="448" alt="Clipboard_Screenshot_1769739939" src="https://github.com/user-attachments/assets/d6f37458-900c-4de9-8fdc-f8e6bf5c7ee5" />

### 1.3.0（即将更新）
- 支持回复图片等功能
- 支持定时任务到时后主动推送

### 1.2.5
- 解除URL发送限制，现在可以直接在私聊发送URL
  <img width="1786" height="576" alt="Clipboard_Screenshot_1770092858" src="https://github.com/user-attachments/assets/c660949e-28a5-4e5f-abc2-77f0a2c67bad" />
- 更新Bot正在输入中状态
   <img width="1440" height="412" alt="Clipboard_Screenshot_1770091969" src="https://github.com/user-attachments/assets/47835c4b-ccd2-4782-aaa6-b873cb58f7d7" />
- 提供主动推送能力（目前AI还不知道怎么调用主动推送，相关完整Skill能力将在后续版本更新）
- 优化一些已知问题
- 优化未收到未收到大模型响应时的提示信息


### 1.2.2
- 支持发送文件
- 支持openclaw、moltbot命令行
- 修复[health]检查提示: [health] refresh failed: Cannot read properties of undefined (reading 'appId')的问题（不影响使用）
- 修复文件发送后clawdbot无法读取的问题

### 1.2.1
- 解决了长时间使用会断联的问题
- 解决了频繁重连的问题
- 增加了大模型调用失败后的提示消息


### 1.1.0
- 解决了一些url会被拦截的问题
- 解决了多轮消息会发送失败的问题
- 修复了部分图片无法接受的问题
- 增加支持onboard的方式配置AppId 和 AppSecret


## 安装

在插件目录下执行：

```bash
git clone https://github.com/sliverp/qqbot.git && cd qqbot
clawdbot plugins install . # 这一步会有点久，需要安装一些依赖。稍微耐心等待一下，尤其是小内存机器
```

## 配置

### 1. 获取 QQ 机器人凭证

1. 访问 [QQ 开放平台](https://q.qq.com/)
2. 创建机器人应用
3. 获取 `AppID` 和 `AppSecret`（ClientSecret）
4. Token 格式为 `AppID:AppSecret`，例如 `102146862:Xjv7JVhu7KXkxANbp3HVjxCRgvAPeuAQ`

### 2. 添加配置

#### 方式一：交互式配置

```bash
clawdbot channels add
# 选择 qqbot，按提示输入 Token
```

#### 方式二：命令行配置

```bash
clawdbot channels add --channel qqbot --token "AppID:AppSecret"
```

示例：

```bash
clawdbot channels add --channel qqbot --token "102146862:xxxxxxxx"
```

### 3. 手动编辑配置（可选）

也可以直接编辑 `~/.clawdbot/clawdbot.json`：

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "你的AppID",
      "clientSecret": "你的AppSecret",
      "systemPrompt": "你是一个友好的助手"
    }
  }
}
```



## 配置项说明

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `appId` | string | 是 | QQ 机器人 AppID |
| `clientSecret` | string | 是* | AppSecret，与 `clientSecretFile` 二选一 |
| `clientSecretFile` | string | 是* | AppSecret 文件路径 |
| `enabled` | boolean | 否 | 是否启用，默认 `true` |
| `name` | string | 否 | 账户显示名称 |
| `systemPrompt` | string | 否 | 自定义系统提示词 |

## 支持的消息类型

| 事件类型 | 说明 | Intent |
|----------|------|--------|
| `C2C_MESSAGE_CREATE` | C2C 单聊消息 | `1 << 25` |
| `GROUP_AT_MESSAGE_CREATE` | 群聊 @机器人消息 | `1 << 25` |
| `AT_MESSAGE_CREATE` | 频道 @机器人消息 | `1 << 30` |
| `DIRECT_MESSAGE_CREATE` | 频道私信 | `1 << 12` |

## 使用

### 启动

后台启动
```bash
clawdbot gateway restart
```

前台启动, 方便试试查看日志
```bash
clawdbot gateway --port 18789 --verbose
```

### CLI 配置向导

```bash
clawdbot onboard
# 选择 QQ Bot 进行交互式配置
```

## 注意事项

1. **群消息**：需要在群内 @机器人 才能触发回复
2. **沙箱模式**：新创建的机器人默认在沙箱模式，需要添加测试用户

## 升级

如果需要升级插件，先运行升级脚本清理旧版本：

```bash
git clone https://github.com/sliverp/qqbot.git && cd qqbot 

# 运行升级脚本（清理旧版本和配置）
bash ./scripts/upgrade.sh

# 重新安装插件
clawdbot plugins install . # 这一步会有点久，需要安装一些依赖。稍微耐心等待一下，尤其是小内存机器

# 重新配置
clawdbot channels add --channel qqbot --token "AppID:AppSecret"

# 重启网关
clawdbot gateway restart
```

升级脚本会自动：
- 删除 `~/.clawdbot/extensions/qqbot` 目录
- 清理 `clawdbot.json` 中的 qqbot 相关配置

## 开发

```bash
# 安装依赖
npm install

# 编译
npm run build

# 监听模式
npm run dev
```

## 文件结构

```
qqbot/
├── index.ts          # 入口文件
├── src/
│   ├── api.ts        # QQ Bot API 封装
│   ├── channel.ts    # Channel Plugin 定义
│   ├── config.ts     # 配置解析
│   ├── gateway.ts    # WebSocket 网关
│   ├── onboarding.ts # CLI 配置向导
│   ├── outbound.ts   # 出站消息处理
│   ├── runtime.ts    # 运行时状态
│   └── types.ts      # 类型定义
├── scripts/
│   └── upgrade.sh    # 升级脚本
├── package.json
└── tsconfig.json
```

## 相关链接

- [QQ 机器人官方文档](https://bot.q.qq.com/wiki/)
- [QQ 开放平台](https://q.qq.com/)
- [API v2 文档](https://bot.q.qq.com/wiki/develop/api-v2/)

## License

MIT
