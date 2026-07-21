import { Body, Controller, Get, httpError, Inject, Post } from '@midwayjs/core'
import { Context } from '@midwayjs/koa'
import { PRISMA, PrismaService } from '../../../database/prisma.service.js'
import { ACCESS_TTL_SECONDS, AUTH_SERVICE, type AuthTokens, type IAuthService } from './auth.contract.js'

/** 客户端期望的用户形状(createdAt 为 epoch ms;avatarUrl 暂无,给 null)。 */
export function toUser(u: { id: string; email: string; name: string | null; role: string; createdAt: Date }) {
  return { id: u.id, email: u.email, name: u.name, avatarUrl: null, role: u.role, createdAt: u.createdAt.getTime() }
}

@Controller('/api/auth')
export class AuthController {
  @Inject() ctx!: Context
  @Inject(AUTH_SERVICE) private readonly auth!: IAuthService
  @Inject(PRISMA) private readonly db!: PrismaService

  private async session(tokens: AuthTokens) {
    const user = await this.db.client.user.findUnique({ where: { id: tokens.userId } })
    return { user: toUser(user!), accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: ACCESS_TTL_SECONDS }
  }

  @Post('/register')
  async register(@Body() b: { email: string; password: string; name?: string; deviceLabel?: string; inviteCode?: string }) {
    const tokens = await this.auth.register(b.email, b.password, b.name)
    /**
     * 记下**注册来源**(IP / 设备 / 邀请码)——「注册管控」页判"同 IP 批量注册"就靠它。
     * 注册成功后补写,不塞进 auth.register 的签名:那是认证的活,来源画像是运营的活,别搅在一起。
     * 写失败不影响注册本身(用户已经建好了,不能因为记不上来源就让他注册不成)。
     */
    try {
      await this.db.client.user.update({
        where: { id: tokens.userId },
        data: {
          signupIp: this.ctx.ip || null,
          signupDevice: typeof b.deviceLabel === 'string' ? b.deviceLabel.slice(0, 120) : null,
          inviteCode: typeof b.inviteCode === 'string' && b.inviteCode.trim() ? b.inviteCode.trim() : null,
        },
      })
    } catch (e) {
      console.error('[auth] 注册来源记录失败(不影响注册):', e)
    }
    return this.session(tokens)
  }

  @Post('/login')
  async login(@Body() b: { email: string; password: string }) {
    return this.session(await this.auth.login(b.email, b.password))
  }

  @Post('/refresh')
  async refresh(@Body('refreshToken') refreshToken: string) {
    return this.auth.refresh(refreshToken)
  }

  @Post('/logout')
  async logout(@Body('refreshToken') refreshToken: string) {
    if (refreshToken) await this.auth.logout(refreshToken)
    return { ok: true }
  }

  @Get('/me')
  async me() {
    return toUser(await this.currentUser())
  }

  private async currentUser() {
    const h = this.ctx.get('authorization') || ''
    const v = this.auth.verifyAccess(h.startsWith('Bearer ') ? h.slice(7) : '')
    const user = v ? await this.db.client.user.findUnique({ where: { id: v.userId } }) : null
    if (!user || user.disabled) throw new httpError.UnauthorizedError()
    return user
  }
}
