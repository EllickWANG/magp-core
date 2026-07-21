import { httpError, Inject, Provide, Scope, ScopeEnum } from '@midwayjs/core'
import { PRISMA, PrismaService } from '../../../database/prisma.service.js'
import {
  REGISTRATION_GATE,
  REG_MODE_KEY,
  isRegMode,
  type IRegistrationGate,
  type RegMode,
  type RegistrationTicket,
} from './registration.contract.js'

/** 抢名额抢输了就重读重试;3 次还抢不到,说明是真没名额了而不是运气差。 */
const RESERVE_RETRIES = 3

/**
 * 注册闸门 —— 后台「注册管控」页那个 open / invite / closed 开关**真正生效的地方**。
 *
 * 在这之前开关是纯装饰:值写进了 SystemSetting,但 /api/auth/register 从头到尾没读过它,
 * 设成 closed 照样随便注册。邀请码同理 —— 只是把用户填的字符串原样存进 user.inviteCode,
 * 谁瞎填一个都能过。
 *
 * 闸门放在注册**之前**,和 auth.controller 里那段"注册来源补写"刚好相反:
 * 来源画像是事后记账,记不上不该挡住注册;闸门是准入,漏一次就等于没有。
 */
@Provide(REGISTRATION_GATE)
@Scope(ScopeEnum.Singleton)
export class RegistrationGate implements IRegistrationGate {
  @Inject(PRISMA) private readonly db!: PrismaService

  async mode(): Promise<RegMode> {
    const row = await this.db.client.systemSetting.findUnique({ where: { key: REG_MODE_KEY } })
    // 没配过 / 配了个不认识的值 —— 都当 open。**不能当 closed**:一个拼错的值
    // 会把所有人挡在门外,而且现象是"注册页说关闭了",没人会想到去查设置表。
    return isRegMode(row?.value) ? row.value : 'open'
  }

  async admit(inviteCode?: string | null): Promise<RegistrationTicket> {
    const mode = await this.mode()
    if (mode === 'closed') throw new httpError.ForbiddenError('当前未开放注册')
    if (mode === 'open') return noopTicket(null)

    const code = (inviteCode ?? '').trim()
    if (!code) throw new httpError.BadRequestError('当前仅限邀请注册,请填写邀请码')
    return this.reserve(code)
  }

  /**
   * 预占一个名额。
   *
   * 「读出来看看还有没有名额,然后 +1」在并发下是错的:两个人同时抢最后一个名额会双双通过。
   * 这里用**乐观并发** —— 更新时带上读到的 usedCount 作为条件,被别人抢先则 updateMany
   * 匹配 0 行,重读再试。(Prisma 的 where 没法拿一列去比另一列,所以不能直接写
   * `usedCount < maxUses`;真要一条 SQL 搞定就得下沉到 $executeRaw,不值得为这点并发量
   * 换来一段和 @map 列名绑死的裸 SQL。)
   */
  private async reserve(code: string): Promise<RegistrationTicket> {
    for (let i = 0; i < RESERVE_RETRIES; i++) {
      const row = await this.db.client.inviteCode.findUnique({ where: { code } })
      if (!row || !row.active) throw new httpError.BadRequestError('邀请码无效')
      if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
        throw new httpError.BadRequestError('邀请码已过期')
      }
      if (row.usedCount >= row.maxUses) throw new httpError.BadRequestError('邀请码已用完')

      const { count } = await this.db.client.inviteCode.updateMany({
        where: { id: row.id, usedCount: row.usedCount }, // 读到多少就按多少改,变了说明被人抢先
        data: { usedCount: { increment: 1 } },
      })
      if (count === 1) return this.ticket(row.id, code)
    }
    throw new httpError.BadRequestError('邀请码已用完')
  }

  private ticket(id: string, code: string): RegistrationTicket {
    let released = false
    return {
      inviteCode: code,
      release: async (): Promise<void> => {
        if (released) return
        released = true
        // 只在 >0 时减,避免任何情况下把计数减成负数。
        await this.db.client.inviteCode.updateMany({
          where: { id, usedCount: { gt: 0 } },
          data: { usedCount: { decrement: 1 } },
        })
      },
    }
  }
}

const noopTicket = (inviteCode: string | null): RegistrationTicket => ({
  inviteCode,
  release: async (): Promise<void> => {},
})
