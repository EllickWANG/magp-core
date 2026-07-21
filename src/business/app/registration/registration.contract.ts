/**
 * 注册管控域的契约 —— 注册模式 + 邀请码闸门。
 *
 * 常量放这里而不是各自 controller 里抄一份:CMS 写 registration.mode、注册链路读它,
 * 两边抄同一个字符串的话,哪天改成 'reg.mode' 就会变成「后台点了没反应、还查不出为什么」。
 */
export const REGISTRATION_GATE = 'app:registration-gate'

/** 存在 SystemSetting 里的键。 */
export const REG_MODE_KEY = 'registration.mode'

export const REG_MODES = ['open', 'invite', 'closed'] as const
export type RegMode = (typeof REG_MODES)[number]

export const isRegMode = (v: unknown): v is RegMode => REG_MODES.includes(v as RegMode)

/**
 * 一次放行凭据。invite 模式下**名额已经被预占**(注册还没发生),
 * 所以注册失败必须 release() —— 否则一个建号失败就白白吃掉一个名额。
 */
export interface RegistrationTicket {
  /** 实际用掉的邀请码(open 模式下为 null)。 */
  inviteCode: string | null
  /** 把预占的名额还回去。注册成功则不要调用。多次调用无副作用。 */
  release(): Promise<void>
}

export interface IRegistrationGate {
  /** 当前注册模式;没配过 = open。 */
  mode(): Promise<RegMode>
  /**
   * 注册前闸门。closed 直接拒;invite 校验邀请码并预占名额;open 放行。
   * 不通过时抛 4xx —— 拒绝的理由要能原样给到注册页上。
   */
  admit(inviteCode?: string | null): Promise<RegistrationTicket>
}
