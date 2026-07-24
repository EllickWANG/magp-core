import { Provide, Scope, ScopeEnum } from '@midwayjs/core'
import type { AgentEvent, Message } from '../domain/index.js'
import { toolResultMessage } from '../domain/index.js'
import { TRANSCRIPT_STORE, type ITranscriptStore } from './transcript.contract.js'
import { appendSessionEvents, listSessionEvents, maxSessionEventSeq } from '../../session-events.js'

/**
 * ITranscriptStore 的实现:内脏就是通用的 session-events(PG)。
 * 落库:每个 AgentEvent 一行(JSON)。重建:只从**结构化事件**物化 Message[] ——
 * user_message / assistant_message 直接取其 message;tool_result 还原成 tool 消息。
 * assistant_delta(逐字)只用于实时下发,不参与重建(assistant_message 已含整条正文,避免重复)。
 */
@Provide(TRANSCRIPT_STORE)
@Scope(ScopeEnum.Singleton)
export class PrismaTranscriptStore implements ITranscriptStore {
  async append(sessionId: string, events: readonly AgentEvent[], _signal: AbortSignal): Promise<void> {
    let seq = await maxSessionEventSeq(sessionId)
    const lines = events.map((e) => ({ seq: ++seq, line: JSON.stringify(e) }))
    await appendSessionEvents(sessionId, lines)
  }

  async load(sessionId: string, _signal: AbortSignal): Promise<readonly Message[]> {
    const rows = await listSessionEvents(sessionId)
    const messages: Message[] = []
    for (const { line } of rows) {
      let e: AgentEvent
      try {
        e = JSON.parse(line) as AgentEvent
      } catch {
        continue // 半截/脏行,跳过而非崩掉整段重建
      }
      if (e.t === 'user_message' || e.t === 'assistant_message') {
        messages.push(e.message)
      } else if (e.t === 'tool_result') {
        // assistant 的 tool_use(在 assistant_message 里)之后紧跟 tool 消息,维持 Anthropic 的配对结构。
        messages.push(toolResultMessage(e.callId, e.result, e.isError))
      }
    }
    return messages
  }
}
