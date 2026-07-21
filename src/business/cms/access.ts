import { httpError } from '@midwayjs/core'
import type { Context } from '@midwayjs/koa'
import type { PrismaService } from '../../database/prisma.service.js'
import type { IAuthService } from '../app/auth/auth.contract.js'
import { PERMISSIONS, parsePermissions } from './permissions.js'

const ALL_KEYS = PERMISSIONS.map((p) => p.key)

export type CmsActor = {
  id: string
  email: string
  /** role==='admin' 的超管:恒定拥有全部权限点,**不受角色表影响**。 */
  superAdmin: boolean
  permissions: string[]
}

/**
 * 后台访问控制 —— 把「谁在请求」和「他能干什么」解析出来。
 *
 * ## 两类后台身份
 *
 *  1. **超管**(`role === 'admin'`):恒定全权限。这条**不能删**——
 *     否则一次角色配错就能把所有人挡在后台门外,而修复入口本身也在后台里(死锁)。
 *     超管是那把永远打得开门的钥匙。
 *  2. **受托管理员**(`role === 'user'` 且指派了 `adminRoleId`):权限 = 该角色勾选的权限点。
 *
 * 其余人根本不是后台用户 → 401。
 *
 * ## 为什么权限点要和代码里的清单取交集
 *
 * 角色是很久以前配的,权限点清单却随代码演进。库里可能留着已经改名/删除的 key;
 * 直接信库,就会出现"这个 key 现在什么都不管了,但界面看起来他还有权限"。
 * 以代码为准做一次交集,库只是投影。
 */
export async function resolveActor(
  ctx: Context,
  auth: IAuthService,
  db: PrismaService,
): Promise<CmsActor | null> {
  const h = ctx.get('authorization') || ''
  const v = auth.verifyAccess(h.startsWith('Bearer ') ? h.slice(7) : '')
  if (!v) return null
  const user = await db.client.user.findUnique({
    where: { id: v.userId },
    include: { adminRole: true },
  })
  if (!user || user.disabled) return null

  if (user.role === 'admin') {
    return { id: user.id, email: user.email, superAdmin: true, permissions: [...ALL_KEYS] }
  }
  if (user.adminRole) {
    return {
      id: user.id,
      email: user.email,
      superAdmin: false,
      permissions: parsePermissions(user.adminRole.permissions),
    }
  }
  return null
}

/**
 * 要求某个权限点。不满足 → 401(不是后台用户)/ 403(是后台用户但没这个权限)。
 * 返回操作者,调用方拿它写审计(审计必须记清是谁干的)。
 */
export async function requirePermission(
  ctx: Context,
  auth: IAuthService,
  db: PrismaService,
  permission: string,
): Promise<CmsActor> {
  const actor = await resolveActor(ctx, auth, db)
  if (!actor) throw new httpError.UnauthorizedError()
  if (!actor.permissions.includes(permission)) {
    // 说清缺哪个权限点 —— 「没有权限」这种话让人无从下手,也没法告诉管理员该勾什么。
    throw new httpError.ForbiddenError(`缺少权限:${permission}`)
  }
  return actor
}
