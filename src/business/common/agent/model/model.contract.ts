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
