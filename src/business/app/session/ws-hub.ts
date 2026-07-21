import { Provide, Scope, ScopeEnum } from '@midwayjs/core'
import type { WebSocket } from 'ws'

/**
 * 共享 socket 登记:sessionId → 连接集合。gateway 写、channel 读。
 *
 * ## 这里**故意不发心跳**
 *
 * 加过一版 25s 定时 ping 来对抗反代的空闲超时,又去掉了 —— 因为它的效果是
 * **让空闲连接永不断开**,而我们要的恰恰相反:没人用的时候就该断,别占着连接和内存。
 * 客户端是懒连接的(下次发消息时重建,用同一个 sessionId 续上下文),断开没有代价。
 *
 * 代价说清楚:一轮 agent 任务如果**超过反代空闲超时(nginx 默认 60s)还没有任何数据流出**,
 * 连接会被掐断,这一轮就断在半路。正常工具都在 60s 内有回包(读页约 10s、生图约 30s),
 * 只有 automation_run(可跑几分钟)有这个风险。真撞上了,再考虑「仅在有活跃 turn 时保活」——
 * 那才是对症的做法,而不是给所有空闲连接都插一根管子。
 */
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
