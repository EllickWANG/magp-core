import { Provide, Scope, ScopeEnum } from '@midwayjs/core'
import type { AgentEvent, Message } from '../domain/index.js'
import { TRANSCRIPT_STORE, type ITranscriptStore } from './transcript.contract.js'
import { appendSessionEvents, maxSessionEventSeq } from '../../session-events.js'

/**
 * ITranscriptStore 的实现:内脏就是通用的 session-events(PG)。
 * TODO: load 时从 session_events 物化成 Message[](读时重建);
 *       AgentEvent→line 走 IClientProtocol.toTranscriptLine(与 wire 同源)。
 */
@Provide(TRANSCRIPT_STORE)
@Scope(ScopeEnum.Singleton)
export class PrismaTranscriptStore implements ITranscriptStore {
  async append(sessionId: string, events: readonly AgentEvent[], _signal: AbortSignal): Promise<void> {
    let seq = await maxSessionEventSeq(sessionId)
    const lines = events.map((e) => ({ seq: ++seq, line: JSON.stringify(e) }))
    await appendSessionEvents(sessionId, lines)
  }

  async load(_sessionId: string, _signal: AbortSignal): Promise<readonly Message[]> {
    // TODO: const lines = await listSessionEvents(sessionId); return rebuildMessages(lines)
    return []
  }
}
