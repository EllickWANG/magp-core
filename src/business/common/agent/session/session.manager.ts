import { randomUUID } from 'node:crypto'
import { Config, Inject, Provide, Scope, ScopeEnum } from '@midwayjs/core'
import type { AgentEvent, Message } from '../domain/index.js'
import {
  AGENT_ENGINE,
  type IAgentEngine,
  type SessionInput,
  type UserTurnInput,
} from '../engine/agent.contract.js'
import { CLIENT_PROTOCOL, type IClientProtocol, type WireFrame } from '../protocol/protocol.contract.js'
import { TRANSCRIPT_STORE, type ITranscriptStore } from '../persistence/transcript.contract.js'
import { CLIENT_CHANNEL, type IClientChannel } from './channel.contract.js'

/** steering 输入队列:实现引擎的 SessionInput。 */
class InputQueue implements SessionInput {
  private readonly buf: UserTurnInput[] = []
  private waiter: (() => void) | null = null
  private ended = false
  constructor(readonly signal: AbortSignal) {
    signal.addEventListener('abort', () => this.wake(), { once: true })
  }
  push(i: UserTurnInput): void {
    this.buf.push(i)
    this.wake()
  }
  end(): void {
    this.ended = true
    this.wake()
  }
  private wake(): void {
    const w = this.waiter
    this.waiter = null
    w?.()
  }
  async next(signal: AbortSignal): Promise<UserTurnInput | null> {
    for (;;) {
      if (this.buf.length > 0) return this.buf.shift() ?? null
      if (this.ended || signal.aborted) return null
      await new Promise<void>((resolve) => (this.waiter = resolve))
    }
  }
}

class SessionRuntime {
  readonly abort = new AbortController()
  readonly queue = new InputQueue(this.abort.signal)
  constructor(readonly userId: string) {}
  enqueue(i: UserTurnInput): void {
    this.queue.push(i)
  }
  stop(): void {
    this.abort.abort()
    this.queue.end()
  }
}

/**
 * 组合根:装配引擎 + 协议 + 转录 + 通道,管理会话生命周期。
 * WS 终结(session-socket)把 client 帧落到 onClientMessage;事件经 codec 广播回客户端 + 写 PG。
 * 断线宽限 / 并发上限 / 卸载策略在这里,不进引擎。
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class AgentSessionManager {
  @Inject(AGENT_ENGINE) private readonly engine!: IAgentEngine
  @Inject(CLIENT_PROTOCOL) private readonly protocol!: IClientProtocol
  @Inject(TRANSCRIPT_STORE) private readonly transcript!: ITranscriptStore
  @Inject(CLIENT_CHANNEL) private readonly channel!: IClientChannel

  @Config('agent')
  private readonly cfg!: { system: string; maxSteps: number }

  private readonly live = new Map<string, SessionRuntime>()
  /** 最后一个 socket 断开后的宽限计时器:期内重连则取消,避免抖动/切页面就杀掉正在跑的这一轮。 */
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private static readonly GRACE_MS = 30_000

  /** session-socket 的 {kind:'client'} 落这里(已验票 → userId)。 */
  async onClientMessage(sessionId: string, userId: string, wire: WireFrame): Promise<void> {
    const rt = this.live.get(sessionId) ?? (await this.start(sessionId, userId))
    rt.enqueue(this.protocol.decodeClientMessage(wire))
  }

  interrupt(sessionId: string): void {
    this.clearGrace(sessionId)
    this.live.get(sessionId)?.stop()
  }

  /**
   * 某 session 的**最后一个** socket 断开 —— 不立刻中断,先宽限 GRACE_MS。
   * 期内有 socket 重连(socketReconnected)则取消;超时才真正中断这一轮。
   * 断连≠取消:配合 transcript.load 重建,历史在宽限内保留在内存、无需重读 PG。
   */
  socketGone(sessionId: string): void {
    this.clearGrace(sessionId)
    const timer = setTimeout(() => {
      this.graceTimers.delete(sessionId)
      this.live.get(sessionId)?.stop()
    }, AgentSessionManager.GRACE_MS)
    timer.unref?.() // 别因为这个后台计时器挡住进程退出
    this.graceTimers.set(sessionId, timer)
  }

  /** 有 socket(重新)连上:取消待定的宽限中断,保住正在跑的这一轮。 */
  socketReconnected(sessionId: string): void {
    this.clearGrace(sessionId)
  }

  private clearGrace(sessionId: string): void {
    const t = this.graceTimers.get(sessionId)
    if (t) {
      clearTimeout(t)
      this.graceTimers.delete(sessionId)
    }
  }

  private async start(sessionId: string, userId: string): Promise<SessionRuntime> {
    const rt = new SessionRuntime(userId)
    this.live.set(sessionId, rt)

    const messages: Message[] = [...(await this.transcript.load(sessionId, rt.abort.signal))]
    const gen = this.engine.runSession(
      {
        meta: { sessionId, userId },
        system: this.cfg.system,
        messages,
        newId: () => randomUUID(),
        maxSteps: this.cfg.maxSteps,
      },
      rt.queue,
    )

    void this.pump(sessionId, rt, gen).finally(() => this.live.delete(sessionId))
    return rt
  }

  private async pump(
    sessionId: string,
    rt: SessionRuntime,
    gen: AsyncGenerator<AgentEvent>,
  ): Promise<void> {
    for await (const e of gen) {
      const frame = this.protocol.encode(e)
      if (frame) this.channel.send(sessionId, frame)
      await this.transcript.append(sessionId, [e], rt.abort.signal)
    }
  }
}
