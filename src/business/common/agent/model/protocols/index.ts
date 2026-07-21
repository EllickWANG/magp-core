import { AnthropicProtocol } from './anthropic.protocol.js'
import { OpenAIChatProtocol } from './openai-chat.protocol.js'
import { OpenAIResponsesProtocol } from './openai-responses.protocol.js'
import { normalizeFormat, type ApiFormat, type IChatProtocol } from './protocol.contract.js'

/**
 * 协议注册表 —— 加一家新协议 = 在这里加一行,别处不用动。
 * deepseek 原生复用 OpenAI Chat 实现(它的对话接口就是 OpenAI 兼容的),
 * 但**保留独立的 format**:CMS 上要能分辨,将来它若加了私有字段也有地方落。
 */
const REGISTRY = new Map<ApiFormat, IChatProtocol>([
  ['anthropic', new AnthropicProtocol()],
  ['openai_chat', new OpenAIChatProtocol('openai_chat')],
  ['openai_responses', new OpenAIResponsesProtocol()],
  ['deepseek_chat', new OpenAIChatProtocol('deepseek_chat')],
])

export function protocolFor(apiFormat: string | null | undefined): IChatProtocol {
  return REGISTRY.get(normalizeFormat(apiFormat)) ?? REGISTRY.get('openai_chat')!
}

export * from './protocol.contract.js'
export { apiUrl, openaiBaseURL } from './url.js'
