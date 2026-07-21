import { httpError, Inject, Provide, Scope, ScopeEnum } from '@midwayjs/core'
import { createHash, randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { PRISMA, PrismaService } from '../../../database/prisma.service.js'
import { AUTH_SERVICE, type AuthTokens, type IAuthService } from './auth.contract.js'

const ACCESS_TTL = '15m'
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const secret = (): string => process.env.AUTH_SECRET ?? 'magp-core-dev-secret'

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10)
}

/**
 * IAuthService。access = 标准 JWT(sub=userId);refresh = 随机串,库存 sha256,
 * 吊销打 revokedAt 不删行。密码 bcrypt。
 */
@Provide(AUTH_SERVICE)
@Scope(ScopeEnum.Singleton)
export class AuthService implements IAuthService {
  @Inject(PRISMA) private readonly db!: PrismaService

  async register(email: string, password: string, name?: string): Promise<AuthTokens> {
    if (await this.db.client.user.findUnique({ where: { email } })) {
      throw new httpError.BadRequestError('邮箱已注册')
    }
    const user = await this.db.client.user.create({
      data: { email, name: name ?? null, role: 'user', password: await hashPassword(password) },
    })
    return this.issue(user.id)
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db.client.authToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  private async issue(userId: string): Promise<AuthTokens> {
    const refreshToken = randomBytes(32).toString('base64url')
    await this.db.client.authToken.create({
      data: { userId, kind: 'refresh', tokenHash: sha256(refreshToken), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
    })
    return { accessToken: this.signAccess(userId), refreshToken, userId }
  }

  async login(email: string, password: string): Promise<AuthTokens> {
    const user = await this.db.client.user.findUnique({ where: { email } })
    if (!user || user.disabled || !user.password) throw new Error('登录失败')
    if (!(await bcrypt.compare(password, user.password))) throw new Error('登录失败')
    return this.issue(user.id)
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string }> {
    const row = await this.db.client.authToken.findUnique({ where: { tokenHash: sha256(refreshToken) } })
    if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) throw new Error('refresh 无效')
    await this.db.client.authToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    return { accessToken: this.signAccess(row.userId) }
  }

  verifyAccess(accessToken: string): { userId: string } | null {
    try {
      const decoded = jwt.verify(accessToken, secret()) as { sub?: string }
      return decoded.sub ? { userId: decoded.sub } : null
    } catch {
      return null
    }
  }

  private signAccess(userId: string): string {
    return jwt.sign({ sub: userId }, secret(), { expiresIn: ACCESS_TTL })
  }
}
