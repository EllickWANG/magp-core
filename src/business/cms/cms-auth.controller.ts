import { Body, Controller, Get, httpError, Inject, Post } from '@midwayjs/core'
import { Context } from '@midwayjs/koa'
import { PRISMA, PrismaService } from '../../database/prisma.service.js'
import { PERMISSIONS, parsePermissions } from './permissions.js'
import { AUTH_SERVICE, type IAuthService } from '../app/auth/auth.contract.js'
import { resolveActor } from './access.js'

/** cms 前端期望的用户形状(createdAt 为 epoch ms)。 */
function toUser(u: { id: string; email: string; name: string | null; role: string; createdAt: Date }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.createdAt.getTime() }
}

/**
 * CMS 认证:/api/cms/auth/*。仅管理员可登录后台。
 * 响应经 ResponseWrapMiddleware 包成 {success,data}。
 */
@Controller('/api/cms/auth')
export class CmsAuthController {
  @Inject() ctx!: Context
  @Inject(AUTH_SERVICE) private readonly auth!: IAuthService
  @Inject(PRISMA) private readonly db!: PrismaService

  @Post('/login')
  async login(@Body('email') email: string, @Body('password') password: string) {
    const tokens = await this.auth.login(email, password, {
      ip: this.ctx.ip || null,
      userAgent: this.ctx.get('user-agent') || null,
    })
    const user = await this.db.client.user.findUnique({ where: { id: tokens.userId }, include: { adminRole: true } })
    // 能进后台的两类人:超管,或被指派了后台角色的受托管理员。
    if (!user || (user.role !== 'admin' && !user.adminRoleId)) {
      throw new httpError.ForbiddenError('这个账号没有后台权限')
    }
    const permissions =
      user.role === 'admin' ? PERMISSIONS.map((p) => p.key) : parsePermissions(user.adminRole?.permissions ?? '[]')
    return { user: { ...toUser(user), permissions }, accessToken: tokens.accessToken }
  }

  /**
   * 当前后台身份 + **有效权限点**。前端据此显隐菜单/按钮 ——
   * 但那只是体验:每个接口自己还会再判一次(access.ts),前端藏起来不等于调不到。
   */
  @Get('/me')
  async me() {
    const actor = await resolveActor(this.ctx, this.auth, this.db)
    if (!actor) throw new httpError.UnauthorizedError()
    const user = await this.db.client.user.findUnique({ where: { id: actor.id } })
    return { ...toUser(user!), permissions: actor.permissions }
  }
}
