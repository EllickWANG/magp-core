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
    const msg = userMessage(turn.content)
    base.messages.push(msg)
    // 落一条 user_message 事件(codec 不下发给客户端)——否则重建历史时用户的话全丢,
    // 会话变成"只记得自己说过什么、不记得用户问过什么"。
    yield { t: 'user_message', message: msg }
    yield* runTurn({ ...base, signal: input.signal })
  }
}
