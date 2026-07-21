import { Body, Controller, httpError, Inject, Post } from '@midwayjs/core'
import { Context } from '@midwayjs/koa'
import { AUTH_SERVICE, type IAuthService } from '../auth/auth.contract.js'
import * as guard from './guard.service.js'

/**
 * 浏览器风控闸门端点 —— 客户端每次触达动作(开页/点击/翻页)前来这里拿节奏/预算裁决,
 * 撞到风控页时来 mark-blocked 上报冷却。决策算法全在 guard.service(客户端设备上没有)。
 */
@Controller('/api/guard')
export class GuardController {
  @Inject() ctx!: Context
  @Inject(AUTH_SERVICE) private readonly auth!: IAuthService

  @Post('/risk-check')
  async riskCheck(@Body() body: Record<string, unknown>): Promise<{ blocked: boolean }> {
    this.requireUser()
    const b = body ?? {}
    return {
      blocked: guard.riskCheck(
        typeof b.text === 'string' ? b.text : '',
        typeof b.url === 'string' ? b.url : '',
      ),
    }
  }

  @Post('/before-action')
  async beforeAction(@Body() body: Record<string, unknown>): Promise<guard.Decision> {
    const user = this.requireUser()
    const b = body ?? {}
    const identityId = typeof b.identityId === 'string' && b.identityId ? b.identityId : 'default'
    return guard.beforeAction(user.userId, identityId, b.costly === true)
  }

  @Post('/mark-blocked')
  async markBlocked(@Body() body: Record<string, unknown>): Promise<{ ok: true }> {
    const user = this.requireUser()
    const b = body ?? {}
    const identityId = typeof b.identityId === 'string' && b.identityId ? b.identityId : 'default'
    guard.markBlocked(user.userId, identityId)
    return { ok: true }
  }

  private requireUser(): { userId: string } {
    const h = this.ctx.get('authorization') || ''
    const v = this.auth.verifyAccess(h.startsWith('Bearer ') ? h.slice(7) : '')
    if (!v) throw new httpError.UnauthorizedError()
    return v
  }
}
