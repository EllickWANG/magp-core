import { Provide, Scope, ScopeEnum } from '@midwayjs/core'
import { getPrisma, type PrismaClient } from './prisma.js'

export const PRISMA = 'db:prisma'

/**
 * Prisma 的 Midway 封装,供业务/agent 组件 @Inject(PRISMA) 使用。
 * 底层仍是单例(getPrisma),保证全进程一个连接池。
 */
@Provide(PRISMA)
@Scope(ScopeEnum.Singleton)
export class PrismaService {
  get client(): PrismaClient {
    return getPrisma()
  }
}
