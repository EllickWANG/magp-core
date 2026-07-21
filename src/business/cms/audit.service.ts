import { Inject, Provide, Scope, ScopeEnum } from '@midwayjs/core'
import { PRISMA, PrismaService } from '../../database/prisma.service.js'

export const AUDIT_SERVICE = 'cms:audit-service'

export interface IAuditService {
  /** 记一条后台审计。**永不抛** —— 审计写失败不该把正在做的业务操作一起弄挂。 */
  record(input: {
    userId?: string | null
    userEmail?: string | null
    action: string
    detail?: unknown
    ip?: string | null
  }): Promise<void>
}

/**
 * 后台审计 —— 只增不改不删。
 *
 * 谁在什么时候看了哪把密钥、停用了谁、改了谁的角色,出事时要能一条条对回来。
 * 所以:**写失败只打日志、不冒泡**(审计挂了不能连累业务),但业务成功后必须落一条。
 */
@Provide(AUDIT_SERVICE)
@Scope(ScopeEnum.Singleton)
export class AuditService implements IAuditService {
  @Inject(PRISMA) private readonly db!: PrismaService

  async record(input: {
    userId?: string | null
    userEmail?: string | null
    action: string
    detail?: unknown
    ip?: string | null
  }): Promise<void> {
    try {
      await this.db.client.auditLog.create({
        data: {
          userId: input.userId ?? null,
          userEmail: input.userEmail ?? null,
          action: input.action,
          detail: input.detail === undefined ? null : JSON.stringify(input.detail),
          ip: input.ip ?? null,
        },
      })
    } catch (e) {
      console.error('[audit] 写审计失败(不影响业务):', input.action, e)
    }
  }
}
