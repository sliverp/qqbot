// ── QQ 消息类型常量（message_type 枚举值） ──
/** 普通文本消息 */
export const MSG_TYPE_TEXT = 0;
/** 引用（回复）消息 */
export const MSG_TYPE_QUOTE = 103;

/**
 * QQ Bot 配置类型
 */
export interface QQBotConfig {
  appId: string;
  clientSecret?: string;
  clientSecretFile?: string;
}

/**
 * 解析后的 QQ Bot 账户
 */
export interface ResolvedQQBotAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  clientSecret: string;
  secretSource: "config" | "file" | "env" | "none";
  /** 系统提示词 */
  systemPrompt?: string;
  /** 图床服务器公网地址 */
  imageServerBaseUrl?: string;
  /** 是否支持 markdown 消息（默认 true） */
  markdownSupport: boolean;
  config: QQBotAccountConfig;
}

/** 群消息策略：open=全响应 | allowlist=白名单 | disabled=不响应 */
export type GroupPolicy = "open" | "allowlist" | "disabled";

/** 工具策略：full=全部 | restricted=限制敏感工具 | none=禁止 */
export type ToolPolicy = "full" | "restricted" | "none";

/** 单个群的配置 */
export interface GroupConfig {
  /** 是否需要 @机器人才响应（默认 true） */
  requireMention?: boolean;
  /**
   * 是否忽略 @了其他用户但没有 @机器人的消息（默认 false）。
   * 开启后，消息中 @了其他人但未 @bot 时直接丢弃（不记录历史、不触发 AI）。
   */
  ignoreOtherMentions?: boolean;
  /** 群聊中 AI 可使用的工具范围（默认 restricted） */
  toolPolicy?: ToolPolicy;
  /** 群名称 */
  name?: string;
  /** 群消息行为 PE（未配置时使用内置默认值） */
  prompt?: string;
  /** 群历史消息缓存条数（0 禁用，默认 20） */
  historyLimit?: number;
}

/**
 * QQ Bot 账户配置
 */
export interface QQBotAccountConfig {
  enabled?: boolean;
  name?: string;
  appId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  dmPolicy?: "open" | "pairing" | "allowlist";
  allowFrom?: string[];
  /** 群消息策略（默认 allowlist） */
  groupPolicy?: GroupPolicy;
  /** 群白名单（groupPolicy 为 allowlist 时生效） */
  groupAllowFrom?: string[];
  /** 群配置映射（按 groupOpenid 索引，"*" 为默认） */
  groups?: Record<string, GroupConfig>;
  /** 系统提示词，会添加在用户消息前面 */
  systemPrompt?: string;
  /** 图床服务器公网地址，用于发送图片，例如 http://your-ip:18765 */
  imageServerBaseUrl?: string;
  /** 是否支持 markdown 消息（默认 true，设为 false 可禁用） */
  markdownSupport?: boolean;
  /**
   * @deprecated 请使用 audioFormatPolicy.uploadDirectFormats
   * 可直接上传的音频格式（不转换为 SILK），向后兼容
   */
  voiceDirectUploadFormats?: string[];
  /**
   * 音频格式策略配置
   * 统一管理入站（STT）和出站（上传）的音频格式转换行为
   */
  audioFormatPolicy?: AudioFormatPolicy;
  /**
   * 是否启用公网 URL 直传 QQ 平台（默认 true）
   * 启用时：公网 URL 先直传给 QQ 开放平台的富媒体 API，平台自行拉取；失败后自动 fallback 到插件下载再 Base64 上传
   * 禁用时：公网 URL 始终由插件先下载到本地，再以 Base64 上传（适用于 QQ 平台无法访问目标 URL 的场景）
   */
  urlDirectUpload?: boolean;
  /**
   * /bot-upgrade 指令返回的升级指引网址
   * 默认: https://doc.weixin.qq.com/doc/w3_AKEAGQaeACgCNHrh1CbHzTAKtT2gB?scode=AJEAIQdfAAozxFEnLZAKEAGQaeACg
   */
  upgradeUrl?: string;
  /**
   * /bot-upgrade 指令的行为模式
   * - "doc"：展示升级文档链接（安全模式）
   * - "hot-reload"：检测到新版本时直接执行 npm 升级脚本进行热更新（默认）
   */
  upgradeMode?: "doc" | "hot-reload";
  /**
   * /bot-upgrade 热更新时使用的 npm 包名
   * 支持 "scope/name"（自动补 @）或 "@scope/name" 格式
   * 默认: "@tencent-connect/openclaw-qqbot"
   * 示例: "ryantest/openclaw-qqbot"
   */
  upgradePkg?: string;
  /**
   * 出站消息合并回复（debounce）配置
   * 当短时间内收到多次 deliver 时，将文本合并为一条消息发送，避免消息轰炸
   */
  deliverDebounce?: DeliverDebounceConfig;
  /**
   * 是否启用流式消息（默认 false）
   * 启用后，AI 的回复会以流式形式逐步显示在 QQ 聊天中，
   * 用户可以看到文字逐字出现的打字机效果。
   * 设置为 true 可开启流式消息。
   * 
   * 注意：仅 C2C（私聊）支持流式消息 API。
   */
  streaming?: boolean;
}

/**
 * 出站消息合并回复配置
 */
export interface DeliverDebounceConfig {
  /**
   * 是否启用合并回复（默认 true）
   */
  enabled?: boolean;
  /**
   * 合并窗口时长（毫秒），在此时间内的连续 deliver 会被合并
   * 默认 1500ms
   */
  windowMs?: number;
  /**
   * 最大等待时长（毫秒），从第一条 deliver 开始计算，超过此时间强制发送
   * 防止持续有新 deliver 导致一直不发送
   * 默认 8000ms
   */
  maxWaitMs?: number;
  /**
   * 合并文本之间的分隔符
   * 默认 "\n\n---\n\n"
   */
  separator?: string;
}

/**
 * 音频格式策略：控制哪些格式可跳过转换
 */
export interface AudioFormatPolicy {
  /**
   * STT 模型直接支持的音频格式（入站：跳过 SILK→WAV 转换）
   * 如果 STT 服务支持直接处理某些格式（如 silk/amr），可将其加入此列表
   * 例如: [".silk", ".amr", ".wav", ".mp3", ".ogg"]
   * 默认为空（所有语音都先转换为 WAV 再送 STT）
   */
  sttDirectFormats?: string[];
  /**
   * QQ 平台支持直传的音频格式（出站：跳过→SILK 转换）
   * 默认为 [".wav", ".mp3", ".silk"]（QQ Bot API 原生支持的三种格式）
   * 仅当需要覆盖默认值时才配置此项
   */
  uploadDirectFormats?: string[];
  /**
   * 是否启用语音转码（默认 true）
   * 设为 false 可在环境无 ffmpeg 时跳过转码，直接以文件形式发送
   * 当禁用时，非原生格式的音频会 fallback 到 sendDocument（文件发送）
   */
  transcodeEnabled?: boolean;
}

/**
 * 富媒体附件
 */
export interface MessageAttachment {
  content_type: string;  // 如 "image/png"
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
  url: string;
  voice_wav_url?: string;  // QQ 提供的 WAV 格式语音直链，有值时优先使用以避免 SILK→WAV 转换
  asr_refer_text?: string; // QQ 事件内置 ASR 语音识别文本
}

/**
 * C2C 消息事件
 */
export interface C2CMessageEvent {
  author: {
    id: string;
    union_openid: string;
    user_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  message_scene?: {
    source: string;
    /** ext 数组，可能包含 ref_msg_idx=REFIDX_xxx（引用的消息）和 msg_idx=REFIDX_xxx（自身索引） */
    ext?: string[];
  };
  attachments?: MessageAttachment[];
  /** 消息类型，参见 MSG_TYPE_* */
  message_type?: number;
  /** 消息元素列表，引用消息时 [0] 为被引用的原始消息 */
  msg_elements?: MsgElement[];
}

/**
 * 频道 AT 消息事件
 */
export interface GuildMessageEvent {
  id: string;
  channel_id: string;
  guild_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username?: string;
    bot?: boolean;
  };
  member?: {
    nick?: string;
    joined_at?: string;
  };
  attachments?: MessageAttachment[];
}

/** 消息元素结点，引用消息时 msg_elements[0] 为被引用的原始消息 */
export interface MsgElement {
  /** 消息索引标识 */
  msg_idx?: string;
  /** 消息类型，参见 MSG_TYPE_* 常量 */
  message_type?: number;
  /** 文本内容 */
  content?: string;
  /** 附件列表 */
  attachments?: MessageAttachment[];
  /** 嵌套消息元素（引用消息场景下可能存在） */
  msg_elements?: MsgElement[];
}

/**
 * 群聊 AT 消息事件
 */
export interface GroupMessageEvent {
  author: {
    id: string;
    member_openid: string;
    username?: string;
    bot?: boolean;
  };
  content: string;
  id: string;
  timestamp: string;
  group_id: string;
  group_openid: string;
  message_scene?: {
    source: string;
    ext?: string[];
  };
  attachments?: MessageAttachment[];
  /** @提及列表 */
  mentions?: Array<{
    scope?: "all" | "single";
    id?: string;
    user_openid?: string;
    member_openid?: string;
    nickname?: string;
    bot?: boolean;
    /** 是否 @机器人自身 */
    is_you?: boolean;
  }>;
  /** 消息类型，参见 MSG_TYPE_* */
  message_type?: number;
  /** 消息元素列表，引用消息时 [0] 为被引用的原始消息 */
  msg_elements?: MsgElement[];
}

/**
 * 按钮交互事件（INTERACTION_CREATE）
 */
export interface InteractionEvent {
  /** 事件 ID，用于回应交互（PUT /interactions/{id}） */
  id: string;
  /** 事件类型：11=消息按钮 12=单聊快捷菜单 */
  type: number;
  /** 场景：c2c / group / guild */
  scene?: string;
  /** 场景类型：0=频道 1=群聊 2=单聊 */
  chat_type?: number;
  /** 触发时间 RFC3339 */
  timestamp?: string;
  /** 频道 openid（仅频道场景） */
  guild_id?: string;
  /** 子频道 openid（仅频道场景） */
  channel_id?: string;
  /** 单聊用户 openid（仅 c2c 场景） */
  user_openid?: string;
  /** 群 openid（仅群聊场景） */
  group_openid?: string;
  /** 群内触发用户 openid（仅群聊场景） */
  group_member_openid?: string;
  version: number;
  data: {
    type: number;
    resolved: {
      /** 按钮 action.data 值 */
      button_data?: string;
      /** 按钮 id */
      button_id?: string;
      /** 操作用户 userid（仅频道场景） */
      user_id?: string;
      /** 自定义菜单 id（仅菜单场景） */
      feature_id?: string;
      /** 操作的消息 id（仅频道场景） */
      message_id?: string;
      /** 配置更新：群消息模式 "mention"=@机器人时激活 "always"=总是激活 */
      require_mention?: string;
      /** 配置更新：群消息策略 */
      group_policy?: GroupPolicy;
      /** 配置更新：@文本的名称提及BOT名，多个使用,分隔 */
      mention_patterns?: string;
    };
  };
}

/**
 * WebSocket 事件负载
 */
export interface WSPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}



// ---- 流式消息常量 ----

/** 流式消息输入模式 */
export const StreamInputMode = {
  /** 每次发送的 content_raw 替换整条消息内容 */
  REPLACE: "replace",
} as const;
export type StreamInputMode = (typeof StreamInputMode)[keyof typeof StreamInputMode];

/** 流式消息输入状态 */
export const StreamInputState = {
  /** 正文生成中 */
  GENERATING: 1,
  /** 正文生成结束（终结状态） */
  DONE: 10,
} as const;
export type StreamInputState = (typeof StreamInputState)[keyof typeof StreamInputState];

/** 流式消息内容类型 */
export const StreamContentType = {
  MARKDOWN: "markdown",
} as const;
export type StreamContentType = (typeof StreamContentType)[keyof typeof StreamContentType];

/**
 * 流式消息请求体
 * 对应 StreamReq proto
 */
export interface StreamMessageRequest {
  /** 输入模式 */
  input_mode: StreamInputMode;
  /** 输入状态 */
  input_state: StreamInputState;
  /** 内容类型 */
  content_type: StreamContentType;
  /** markdown 内容 */
  content_raw: string;
  /** 事件 ID */
  event_id: string;
  /** 原始消息 ID */
  msg_id: string;
  /** 流式消息 ID，首次发送后返回，后续分片需携带 */
  stream_msg_id?: string;
  /** 递增序号 */
  msg_seq: number;
  /** 同一条流式会话内的发送索引，从 0 开始，每次发送前递增；新流式会话重新从 0 开始 */
  index: number;
}


