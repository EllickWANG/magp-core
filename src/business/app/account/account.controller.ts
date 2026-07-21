import { Controller, Get, httpError, Inject } from '@midwayjs/core'
import { Context } from '@midwayjs/koa'
import { PRISMA, PrismaService } from '../../../database/prisma.service.js'
import { AUTH_SERVICE, type IAuthService } from '../auth/auth.contract.js'
import { toUser } from '../auth/auth.controller.js'

/** 账户信息(当前用户 + 套餐/配额)。客户端「我的账户」页用。 */
@Controller('/api/account')
export class AccountController {
  @Inject() ctx!: Context
  @Inject(AUTH_SERVICE) private readonly auth!: IAuthService
  @Inject(PRISMA) private readonly db!: PrismaService

  @Get('/')
  async account() {
    const h = this.ctx.get('authorization') || ''
    const v = this.auth.verifyAccess(h.startsWith('Bearer ') ? h.slice(7) : '')
    const user = v ? await this.db.client.user.findUnique({ where: { id: v.userId } }) : null
    if (!user || user.disabled) throw new httpError.UnauthorizedError()

    const sub = await this.db.client.subscription.findFirst({
      where: { userId: user.id, status: 'active' },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    })
    const counter = await this.db.client.usageCounter.findFirst({ where: { userId: user.id }, orderBy: { periodStart: 'desc' } })
    return {
      user: toUser(user),
      plan: sub ? { code: sub.plan.code, name: sub.plan.name, monthlyTokens: sub.plan.monthlyTokens } : null,
      usage: { usedTokens: counter?.usedTokens ?? 0, limitTokens: counter?.limitTokens ?? 0 },
    }
  }
}
