/**
 * agent 领域模型 —— 不可变、可序列化的值。大家共用。
 * 硬约束:不许出现活对象(WebSocket / Promise / DB 句柄 / SDK 对象)。
 */
export type Role = 'user' | 'assistant' | 'tool'

export interface TextPart {
  readonly type: 'text'
  readonly text: string
}
export interface ToolUsePart {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: unknown
}
export interface ToolResultPart {
  readonly type: 'tool_result'
  readonly id: string
  readonly result: unknown
  readonly isError: boolean
}
export type ContentPart = TextPart | ToolUsePart | ToolResultPart

export interface Message {
  readonly role: Role
  readonly content: readonly ContentPart[]
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export interface TurnMeta {
  readonly sessionId: string
  readonly userId: string
}

export type TurnEndReason = 'stop' | 'max_steps' | 'aborted' | 'error'

/** 内核对外唯一货币:AgentEvent。 */
export type AgentEvent =
  /**
   * 用户消息入账 —— **仅用于持久化重建历史**,不下发客户端(客户端本来就有自己发的这条)。
   * 之前只有 assistant/tool 事件落库、用户消息只在内存里,导致 load() 无法重建完整对话。
   */
  | { readonly t: 'user_message'; readonly message: Message }
  | { readonly t: 'turn_start'; readonly turnId: string }
  | { readonly t: 'assistant_delta'; readonly turnId: string; readonly delta: string }
  | { readonly t: 'assistant_message'; readonly turnId: string; readonly message: Message }
  | { readonly t: 'tool_use'; readonly turnId: string; readonly call: ToolCall }
  | { readonly t: 'tool_progress'; readonly turnId: string; readonly callId: string; readonly msg: string }
  | { readonly t: 'tool_result'; readonly turnId: string; readonly callId: string; readonly result: unknown; readonly isError: boolean }
  | { readonly t: 'turn_end'; readonly turnId: string; readonly reason: TurnEndReason }
  | { readonly t: 'error'; readonly turnId: string; readonly code: string; readonly message: string }

// ---- 领域构造器(纯函数,保证消息序列合法) ----
export function userMessage(parts: readonly ContentPart[] | string): Message {
  const content: readonly ContentPart[] =
    typeof parts === 'string' ? [{ type: 'text', text: parts }] : parts
  return { role: 'user', content }
}

export function assistantMessage(text: string, calls: readonly ToolCall[]): Message {
  const content: ContentPart[] = []
  if (text.length > 0) content.push({ type: 'text', text })
  for (const c of calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
  return { role: 'assistant', content }
}

export function toolResultMessage(callId: string, result: unknown, isError: boolean): Message {
  return { role: 'tool', content: [{ type: 'tool_result', id: callId, result, isError }] }
}
