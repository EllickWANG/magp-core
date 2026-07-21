import type { AgentEvent, ContentPart } from '../domain/index.js'

/** 解耦③ 客户端协议 的接口契约 + 注入 token。 */
export const CLIENT_PROTOCOL = 'agent:client-protocol'

export interface WireFrame {
  type: string
  [k: string]: unknown
}

export interface DecodedInput {
  content: readonly ContentPart[] | string
}

/** 客户端 stream-json 协议的唯一存在处(带版本)。内核不认 wire 形状。 */
export interface IClientProtocol {
  readonly version: string
  encode(e: AgentEvent): WireFrame | null
  decodeClientMessage(w: WireFrame): DecodedInput
  toTranscriptLine(e: AgentEvent): string
}
