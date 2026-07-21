/**
 * Prisma 客户端单例 —— core 是业务库的唯一访问方。
 * 库:PostgreSQL(DATABASE_URL 形如 postgresql://user:pass@host:5432/db)。
 * 生成物在 prisma/generated/client(gitignore,不进 node_modules)。
 */
import { PrismaClient } from '../../prisma/generated/client/index.js'

let instance: PrismaClient | null = null

export function getPrisma(): PrismaClient {
  if (!instance) {
    const url = process.env.DATABASE_URL
    // 没有兜底路径:PG 连接串里带着账号密码和主机,猜不出来。
    // 缺了就当场说清楚,别让它在第一次查询时抛一句莫名其妙的连接错误。
    if (!url) throw new Error('DATABASE_URL 未配置 —— core 需要 PostgreSQL 连接串(见 .env.example)')
    instance = new PrismaClient({ datasourceUrl: url })
  }
  return instance
}

export async function disconnectPrisma(): Promise<void> {
  await instance?.$disconnect()
  instance = null
}

export type { PrismaClient }
