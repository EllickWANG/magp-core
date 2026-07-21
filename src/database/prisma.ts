/**
 * Prisma 客户端单例 —— core 是业务库的唯一访问方。
 * 库:SQLite(单文件,DATABASE_URL 形如 file:./data/magp.db)。
 * 生成物在 prisma/generated/client(gitignore,不进 node_modules)。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '../../prisma/generated/client/index.js'

let instance: PrismaClient | null = null

/** 默认 sqlite 文件绝对路径:core/prisma/magp.db(src/database 与 dist/database 都 ../../prisma)。 */
function defaultDbUrl(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  return `file:${path.resolve(dir, '../../prisma/magp.db')}`
}

export function getPrisma(): PrismaClient {
  if (!instance) {
    const url = process.env.DATABASE_URL ?? defaultDbUrl()
    instance = new PrismaClient({ datasourceUrl: url })
  }
  return instance
}

export async function disconnectPrisma(): Promise<void> {
  await instance?.$disconnect()
  instance = null
}

export type { PrismaClient }
