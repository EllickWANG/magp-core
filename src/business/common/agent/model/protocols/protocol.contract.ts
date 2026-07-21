import type { ModelDelta, ModelStreamRequest } from '../model.contract.js'
import type { ModelConfig } from '../model-config.contract.js'

/**
 * 上游协议策略 —— 每种协议一份实现,把「我们的 Message/ToolSpec/ModelDelta」和
 * 「这家上游的请求体/流式事件」之间的翻译**关在自己文件里**。
 *
 * 为什么必须分协议,而不是一律按 OpenAI Chat 调:
 * claude 的 /v1/messages、OpenAI 的 /v1/responses 和 /v1/chat/completions,
 * **请求体、流式事件、工具调用的表示法全都不一样**。用错了协议,上游要么 404 要么 400,
 * 而 agent 侧只表现为「不回话」—— 最难查的一类故障。
 */
export type ApiFormat = 'anthropic' | 'openai_chat' | 'openai_responses' | 'deepseek_chat'

export const API_FORMATS: readonly ApiFormat[] = [
  'anthropic',
  'openai_chat',
  'openai_responses',
  'deepseek_chat',
]

/** 不认识的格式一律当 openai_chat —— 这是事实上的通用兼容层,最不容易错。 */
export function normalizeFormat(v: string | null | undefined): ApiFormat {
  return API_FORMATS.includes(v as ApiFormat) ? (v as ApiFormat) : 'openai_chat'
}

export interface IChatProtocol {
  readonly format: ApiFormat
  /** 流式对话(含工具调用),产出与协议无关的 ModelDelta。 */
  stream(cfg: ModelConfig, req: ModelStreamRequest): AsyncIterable<ModelDelta>
  /** 探活:用**这个协议真实的最小请求**打一次上游。不做重试(探活要的是一次明确结论)。 */
  ping(cfg: ModelConfig, signal: AbortSignal): Promise<void>
}
