import { Provide, Scope, ScopeEnum } from '@midwayjs/core'
import type { WebSocket } from 'ws'

/** 共享 socket 登记:sessionId → 连接集合。gateway 写、channel 读。 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class WsHub {
  private readonly hubs = new Map<string, Set<WebSocket>>()

  register(sessionId: string, socket: WebSocket): void {
    const set = this.hubs.get(sessionId) ?? new Set()
    set.add(socket)
    this.hubs.set(sessionId, set)
  }

  unregister(sessionId: string, socket: WebSocket): void {
    const set = this.hubs.get(sessionId)
    set?.delete(socket)
    if (set && set.size === 0) this.hubs.delete(sessionId)
  }

  broadcast(sessionId: string, payload: string): number {
    const set = this.hubs.get(sessionId)
    if (!set) return 0
    for (const s of set) {
      try {
        s.send(payload)
      } catch {
        /* 忽略单连接失败 */
      }
    }
    return set.size
  }
}
