import { randomUUID } from 'node:crypto'
import { Inject, Provide, Scope, ScopeEnum } from '@midwayjs/core'
import { CLIENT_CHANNEL, type IClientChannel } from '../../common/agent/session/channel.contract.js'
import { WsHub } from './ws-hub.js'

const TOOL_TIMEOUT_MS = 120_000

/**
 * IClientChannel 实现:经 WsHub 广播;client_tool_call 往返用 pending Map 按 callId 关联,
 * 客户端回 client_tool_result 时兑现(WsGateway 调 resolveClientTool)。
 */
@Provide(CLIENT_CHANNEL)
@Scope(ScopeEnum.Singleton)
export class WsClientChannel implements IClientChannel {
  @Inject() private readonly hub!: WsHub
  private readonly pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>()

  send(sessionId: string, frame: unknown): void {
    this.hub.broadcast(sessionId, JSON.stringify(frame))
  }

  request(sessionId: string, frame: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const callId = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const cleanup = () => {
        clearTimeout(timer)
        this.pending.delete(callId)
        signal.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(new Error('aborted'))
      }
      timer = setTimeout(() => {
        cleanup()
        reject(new Error('client tool timeout'))
      }, TOOL_TIMEOUT_MS)
      this.pending.set(callId, {
        resolve: (r) => {
          cleanup()
          resolve(r)
        },
        reject: (e) => {
          cleanup()
          reject(e)
        },
      })
      signal.addEventListener('abort', onAbort, { once: true })
      this.hub.broadcast(sessionId, JSON.stringify({ type: 'client_tool_call', callId, ...frame }))
    })
  }

  resolveClientTool(callId: string, result: unknown, isError: boolean): void {
    const p = this.pending.get(callId)
    if (!p) return
    if (isError) p.reject(new Error(typeof result === 'string' ? result : 'client tool error'))
    else p.resolve(result)
  }
}
