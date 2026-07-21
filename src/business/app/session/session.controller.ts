import { randomUUID } from 'node:crypto'
import { Controller, Get, httpError, Inject, Param, Post } from '@midwayjs/core'
import { Context } from '@midwayjs/koa'
import { AUTH_SERVICE, type IAuthService } from '../auth/auth.contract.js'
import { SESSION_SERVICE, type ISessionService } from './session.contract.js'

@Controller('/api/sessions')
export class SessionController {
  @Inject() ctx!: Context
  @Inject(AUTH_SERVICE) private readonly auth!: IAuthService
  @Inject(SESSION_SERVICE) private readonly sessions!: ISessionService

  private userId(): string {
    const h = this.ctx.get('authorization') || ''
    const token = h.startsWith('Bearer ') ? h.slice(7) : ''
    const v = this.auth.verifyAccess(token)
    if (!v) {
      throw new httpError.UnauthorizedError()
    }
    return v.userId
  }

  @Get('/')
  async list() {
    return this.sessions.listByUser(this.userId())
  }

  /** 创建会话:建 AgentSession 行(WS 前置,否则拿不到票、事件无处落)。 */
  @Post('/')
  async create() {
    const uid = this.userId()
    const sessionId = randomUUID()
    await this.sessions.create(uid, sessionId)
    return { sessionId }
  }

  @Post('/:id/ws-ticket')
  async ticket(@Param('id') id: string) {
    const uid = this.userId()
    // 归属门禁:非 owner 一律 404
    if (!(await this.sessions.isOwner(uid, id))) {
      throw new httpError.NotFoundError()
    }
    return { ticket: await this.sessions.issueTicket(uid, id) }
  }
}
