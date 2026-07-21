import type { AgentEvent, Message } from '../domain/index.js'

/** 解耦④ 持久化/会话 的接口契约 + 注入 token。 */
export const TRANSCRIPT_STORE = 'agent:transcript-store'

export interface ITranscriptStore {
  append(sessionId: string, events: readonly AgentEvent[], signal: AbortSignal): Promise<void>
  load(sessionId: string, signal: AbortSignal): Promise<readonly Message[]>
}
