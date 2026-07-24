import type { Message, ToolCall, TurnMeta } from '../domain/index.js'

/** 解耦① 模型/provider 的接口契约 + 注入 token。 */
export const MODEL_PROVIDER = 'agent:model-provider'

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: unknown // JSON Schema
}

export type ModelDelta =
  | { readonly type: 'text'; readonly delta: string }
  /**
   * 模型的**思考/推理**内容(DeepSeek reasoning_content、OpenAI reasoning、Anthropic thinking)。
   * 一等公民,独立于 text —— 它**绝不能并进 assistant 正文**(那会把思维链原文当答复发给用户,
   * 正是"agent 满屏第三人称自述"的病根)。引擎按需捕获,默认不下发给客户端。
   */
  | { readonly type: 'thinking'; readonly delta: string }
  | { readonly type: 'tool_call'; readonly call: ToolCall }
  | { readonly type: 'stop'; readonly reason: 'stop' | 'length' | 'tool_calls' }

export interface ModelStreamRequest {
  readonly meta: TurnMeta
  readonly system: string
  readonly messages: readonly Message[]
  readonly tools: readonly ToolSpec[]
  readonly signal: AbortSignal
}

export interface IModelProvider {
  stream(req: ModelStreamRequest): AsyncIterable<ModelDelta>
}
