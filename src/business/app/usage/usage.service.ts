import { Inject, Provide, Scope, ScopeEnum } from '@midwayjs/core'
import { PRISMA, PrismaService } from '../../../database/prisma.service.js'
import { USAGE_SERVICE, type IUsageService, type RecordUsageInput } from './usage.contract.js'

/**
 * IUsageService:requestId 幂等(唯一键撞 = 重复,吞掉);配额扣减用原子条件更新(increment)。
 * TODO: 配额门禁(超额拒绝)、周期对齐订阅、reserved/settled 两段式。
 */
@Provide(USAGE_SERVICE)
@Scope(ScopeEnum.Singleton)
export class UsageService implements IUsageService {
  @Inject(PRISMA) private readonly db!: PrismaService

  async record(input: RecordUsageInput): Promise<void> {
    try {
      await this.db.client.usageEvent.create({
        data: {
          userId: input.userId,
          requestId: input.requestId,
          provider: input.provider,
          model: input.model,
          capability: input.capability,
          inputTokens: input.inputTokens ?? 0,
          outputTokens: input.outputTokens ?? 0,
          totalTokens: input.totalTokens,
        },
      })
    } catch (e) {
      // 唯一键(requestId)撞 = 重放,幂等吞掉
      if (isUniqueViolation(e)) return
      throw e
    }
    // 原子扣配额(当前周期计数器须已存在;创建/对齐留待订阅域)
    await this.db.client.usageCounter.updateMany({
      where: { userId: input.userId },
      data: { usedTokens: { increment: input.totalTokens } },
    })
  }
}

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002'
