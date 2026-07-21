/** auth 域:注册 / 登录 / 刷新 / 登出 / 校验。 */
export const AUTH_SERVICE = 'app:auth-service'

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  userId: string
}

export interface IAuthService {
  register(email: string, password: string, name?: string): Promise<AuthTokens>
  login(email: string, password: string): Promise<AuthTokens>
  refresh(refreshToken: string): Promise<{ accessToken: string }>
  logout(refreshToken: string): Promise<void>
  /** 校验 access token,返回 userId 或 null。 */
  verifyAccess(accessToken: string): { userId: string } | null
}

/** access token 有效期(秒)—— 客户端按此提前续期。 */
export const ACCESS_TTL_SECONDS = 15 * 60
