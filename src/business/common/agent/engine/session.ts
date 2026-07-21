import { userMessage, type AgentEvent } from '../domain/index.js'
import type { RunCtx, SessionInput } from './agent.contract.js'
import { runTurn } from './turn.js'

/** 多轮会话循环:从输入队列取用户消息 → 跑一轮 → 重复,直到结束或取消。纯函数。 */
export async function* runSession(
  base: Omit<RunCtx, 'signal'>,
  input: SessionInput,
): AsyncGenerator<AgentEvent> {
  while (!input.signal.aborted) {
    const turn = await input.next(input.signal)
    if (turn === null) return
    base.messages.push(userMessage(turn.content))
    yield* runTurn({ ...base, signal: input.signal })
  }
}
