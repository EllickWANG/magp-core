/**
 * 厂商 / 协议预设 —— 新建服务商时先选它,自动带出**协议格式**、Base URL、默认模型。
 *
 * ## 为什么要有预设,而不是让人自己选协议下拉
 *
 * 协议格式(anthropic / openai_chat / openai_responses / deepseek_chat)是最容易配错、
 * 也最难查的一项:**配错了 agent 一路失败,界面上只表现为「不回话」**。
 * 让人对着一个下拉自己猜,就是在等他选错。把这份知识写进预设,选厂商即选对协议。
 *
 * baseUrl 一律写**不带版本段**的形式 —— 拼接时由 `protocols/url.ts` 的 apiUrl() 自动补 /v1,
 * 用户若填了带 /v1 的地址也能正确识别(两种写法都常见,硬拼任一种都会 404)。
 */
export type ProviderPreset = {
  id: string
  name: string
  baseUrl: string
  apiFormat: string
  authStrategy: string
  defaultModels: { main: string; vision?: string; image?: string }
  apiKeyUrl?: string
  /** 给人看的一句话:这个预设适合什么场景。 */
  hint?: string
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // ── 官方直连 ──────────────────────────────────────────
  {
    id: 'anthropic',
    name: 'Anthropic Claude(原生)',
    baseUrl: 'https://api.anthropic.com',
    apiFormat: 'anthropic',
    authStrategy: 'x-api-key',
    defaultModels: { main: 'claude-opus-4-8', vision: 'claude-opus-4-8' },
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    hint: '走 /v1/messages 原生协议。中转若不透传 messages,请改用 OpenAI Chat 兼容预设。',
  },
  {
    id: 'openai',
    name: 'OpenAI(Chat Completions)',
    baseUrl: 'https://api.openai.com',
    apiFormat: 'openai_chat',
    authStrategy: 'bearer',
    defaultModels: { main: 'gpt-5', vision: 'gpt-5', image: 'gpt-image-2' },
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    hint: '最通用的一档。绝大多数中转都兼容这个协议。',
  },
  {
    id: 'openai_responses',
    name: 'OpenAI(Responses API)',
    baseUrl: 'https://api.openai.com',
    apiFormat: 'openai_responses',
    authStrategy: 'bearer',
    defaultModels: { main: 'gpt-5', image: 'gpt-image-2' },
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    hint: 'OpenAI 新一代 /v1/responses。上游不支持时会 404,拿不准就先选 Chat Completions。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek(原生)',
    baseUrl: 'https://api.deepseek.com',
    apiFormat: 'deepseek_chat',
    authStrategy: 'bearer',
    defaultModels: { main: 'deepseek-chat' },
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    hint: 'OpenAI 兼容的 /chat/completions,额外回 reasoning_content(思维链)。',
  },

  // ── 国内大厂(均 OpenAI 兼容)──────────────────────────
  {
    id: 'qwen',
    name: '阿里通义千问 / 百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    apiFormat: 'openai_chat',
    authStrategy: 'bearer',
    defaultModels: { main: 'qwen-max', vision: 'qwen-vl-max' },
    apiKeyUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiFormat: 'openai_chat',
    authStrategy: 'bearer',
    defaultModels: { main: 'glm-4-plus', vision: 'glm-4v-plus' },
    apiKeyUrl: 'https://bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'volcengine',
    name: '火山引擎 / 豆包(方舟)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiFormat: 'openai_chat',
    authStrategy: 'bearer',
    defaultModels: { main: 'doubao-pro-32k', vision: 'doubao-vision-pro' },
    apiKeyUrl: 'https://console.volcengine.com/ark',
  },
  {
    id: 'moonshot',
    name: 'Moonshot 月之暗面',
    baseUrl: 'https://api.moonshot.cn',
    apiFormat: 'openai_chat',
    authStrategy: 'bearer',
    defaultModels: { main: 'moonshot-v1-32k' },
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow 硅基流动',
    baseUrl: 'https://api.siliconflow.cn',
    apiFormat: 'openai_chat',
    authStrategy: 'bearer',
    defaultModels: { main: 'deepseek-ai/DeepSeek-V3' },
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },

  // ── 通用中转(baseUrl 必须自己填)────────────────────────
  {
    id: 'relay_openai_chat',
    name: '通用中转 · OpenAI Chat 协议',
    baseUrl: '',
    apiFormat: 'openai_chat',
    authStrategy: 'bearer',
    defaultModels: { main: '' },
    hint: '第三方中转最常见的一档。填中转给你的 Base URL(带不带 /v1 都行)。',
  },
  {
    id: 'relay_anthropic',
    name: '通用中转 · Anthropic 原生协议',
    baseUrl: '',
    apiFormat: 'anthropic',
    authStrategy: 'x-api-key',
    defaultModels: { main: '' },
    hint: '仅当中转**明确支持 /v1/messages 透传**时选它;否则会回「该渠道不支持 messages」。',
  },
]
