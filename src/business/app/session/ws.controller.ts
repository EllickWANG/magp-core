import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import { Inject, OnWSConnection, OnWSDisConnection, OnWSMessage, WSController } from '@midwayjs/core'
import { Context } from '@midwayjs/ws'
import { AgentSessionManager } from '../../common/agent/session/session.manager.js'
import { CLIENT_CHANNEL, type IClientChannel } from '../../common/agent/session/channel.contract.js'
import type { WireFrame } from '../../common/agent/protocol/protocol.contract.js'
import { SESSION_SERVICE, type ISessionService } from './session.contract.js'
import { WsHub } from './ws-hub.js'

/**
 * /ws/:sessionId 终结 —— 用 @midwayjs/ws(noServer,共享 koa 端口)。
 * 连接:解析 url 拿 sessionId+ticket → 消费票据(验 userId+归属)→ 登记 WsHub;
 * 消息:user_message→引擎入队 / stop_generation→中断 / client_tool_result→兑现工具往返;
 * 断开:注销 + 中断。控制器按连接实例化,实例字段保存本连接的 sessionId/userId。
 */
@WSController()
export class AgentWsController {
  @Inject() ctx!: Context
  @Inject() private readonly hub!: WsHub
  @Inject() private readonly manager!: AgentSessionManager
  @Inject(SESSION_SERVICE) private readonly sessions!: ISessionService
  @Inject(CLIENT_CHANNEL) private readonly channel!: IClientChannel

  private sessionId = ''
  private userId = ''

  private socket(): WebSocket {
    return this.ctx as unknown as WebSocket
  }

  @OnWSConnection()
  async onConnection() {
    const req = this.ctx.request as IncomingMessage
    const url = new URL(req.url ?? '', 'http://localhost')
    const m = url.pathname.match(/^\/ws\/([^/]+)$/)
    const ticket = url.searchParams.get('ticket') ?? ''
    const consumed = m ? await this.sessions.consumeTicket(ticket) : null
    if (!m || !consumed || consumed.sessionId !== decodeURIComponent(m[1]!)) {
      this.ctx.close(1008, 'unauthorized')
      return
    }
    this.sessionId = consumed.sessionId
    this.userId = consumed.userId
    this.hub.register(this.sessionId, this.socket())
    // 握手:消息监听在 onConnection 之后才绑定,客户端须等到 ready 再发首条消息,避免竞态丢消息。
    this.socket().send(JSON.stringify({ type: 'ready', sessionId: this.sessionId }))
  }

  @OnWSMessage('message')
  async onMessage(data: Buffer) {
    if (!this.sessionId) return
    let frame: { type?: string; callId?: string; result?: unknown; content?: unknown; error?: string; isError?: boolean }
    try {
      frame = JSON.parse(String(data))
    } catch {
      return
    }
    switch (frame.type) {
      case 'user_message':
        await this.manager.onClientMessage(this.sessionId, this.userId, frame as unknown as WireFrame)
        break
      case 'stop_generation':
        this.manager.interrupt(this.sessionId)
        break
      case 'client_tool_result': {
        // 失败:传客户端那句引导性错误文案(reject 时用它,agent 才拿到"该 ask_human"这类纠偏);
        // 成功:传 content(工具真正的结果)。
        const isError = frame.isError ?? false
        const value = isError ? (frame.error ?? frame.result ?? '客户端工具执行失败。') : (frame.result ?? frame.content)
        this.channel.resolveClientTool(frame.callId ?? '', value, isError)
        break
      }
    }
  }

  @OnWSDisConnection()
  async onDisconnect() {
    if (!this.sessionId) return
    this.hub.unregister(this.sessionId, this.socket())
    this.manager.interrupt(this.sessionId)
  }
}
