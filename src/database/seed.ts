/**
 * 初始数据(幂等):默认管理员 + Free 套餐 + 内置超级管理员角色。
 * 模型 provider 由管理员经 CMS 配置(/api/cms/providers + assign),不在此/env 种。
 */
import { getPrisma } from './prisma.js'
import { hashPassword } from '../business/app/auth/auth.service.js'
import { PERMISSIONS } from '../business/cms/permissions.js'

export async function seedDatabase(): Promise<void> {
  const db = getPrisma()

  const email = process.env.ADMIN_EMAIL ?? 'admin@magp.local'
  if (!(await db.user.findUnique({ where: { email } }))) {
    const password = process.env.ADMIN_PASSWORD
    if (!password) throw new Error('ADMIN_PASSWORD 未配置 —— 首次创建管理员时必须设置')
    await db.user.create({
      data: { email, name: 'Admin', role: 'admin', password: await hashPassword(password) },
    })
  }

  await db.plan.upsert({
    where: { code: 'free' },
    create: { code: 'free', name: 'Free', monthlyTokens: 1_000_000 },
    update: {},
  })

  /**
   * 内置角色「超级管理员」——拥有全部权限点,且**不可删除**(isSystem)。
   * 没有它的话,角色页开局是一张空表:你既看不出权限点长什么样,也没有可以对照着改的样板。
   * 权限点清单以代码为准(business/cms/permissions.ts),这里只把当前全集投影进去。
   */
  const all = JSON.stringify(PERMISSIONS.map((p) => p.key))
  await db.adminRole.upsert({
    where: { name: '超级管理员' },
    create: { name: '超级管理员', description: '拥有全部后台权限,内置角色不可删除', isSystem: true, permissions: all },
    update: { permissions: all }, // 新增权限点后,内置角色自动跟上
  })
}
