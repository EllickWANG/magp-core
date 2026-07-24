/** auth 域:注册 / 登录 / 刷新 / 登出 / 校验。 */
export const AUTH_SERVICE = 'app:auth-service'

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  userId: string
}

export interface IAuthService {
  register(email: string, password: string, name?: string): Promise<AuthTokens>
  login(
    email: string,
    password: string,
    /** 签发来源(IP / UA)。用于后台「最近一次登录」与异地登录排查。 */
    origin?: { ip?: string | null; userAgent?: string | null },
  ): Promise<AuthTokens>
  /** 刷新:签发新 access + 滑动续期同一个 refresh(不轮换),返回完整令牌组。 */
  refresh(refreshToken: string): Promise<AuthTokens>
  logout(refreshToken: string): Promise<void>
  /** 校验 access token,返回 userId 或 null。 */
  verifyAccess(accessToken: string): { userId: string } | null
}

/** access token 有效期(秒)—— 客户端按此提前续期。 */
export const ACCESS_TTL_SECONDS = 15 * 60
