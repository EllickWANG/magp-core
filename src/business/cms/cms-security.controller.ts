import { Body, Controller, Del, Get, httpError, Inject, Param, Patch, Post, Query } from '@midwayjs/core'
import { Context } from '@midwayjs/koa'
import { PRISMA, PrismaService } from '../../database/prisma.service.js'
import { AUTH_SERVICE, type IAuthService } from '../app/auth/auth.contract.js'
import { AUDIT_SERVICE, type IAuditService } from './audit.service.js'
import { PERMISSIONS, parsePermissions, sanitizePermissionKeys } from './permissions.js'
import { requirePermission } from './access.js'

const PAGE_SIZE = 20
const ms = (d: Date | null): number | null => (d ? d.getTime() : null)

const REG_MODE_KEY = 'registration.mode'
const REG_MODES = ['open', 'invite', 'closed'] as const
type RegMode = (typeof REG_MODES)[number]

const BUILD_STATUSES = ['pending', 'allowed', 'blocked'] as const

/**
 * 「权限与安全」四块的后台接口 —— 角色权限 / 客户端版本 / 审计日志 / 注册管控。
 *
 * 契约照旧 control-plane 的设计搬(前端本来就是按它写的),不是照着界面反推路径:
 *   /api/cms/rbac/*         角色与权限点
 *   /api/cms/builds         客户端构建软闸
 *   /api/cms/audits         审计日志(**注意**:旧版误挂在 /usage/audits,前端一直调的
 *                           /api/cms/audits 才是对的路径,这里按正确的来)
 *   /api/cms/registration   注册管控(旧后端从未实现,本次新设计)
 *
 * 守卫是**逐端点的权限点**(见 access.ts):超管恒定全权限,受托管理员按角色勾选放行。
 */
@Controller('/api/cms')
export class CmsSecurityController {
  @Inject() ctx!: Context
  @Inject(AUTH_SERVICE) private readonly auth!: IAuthService
  @Inject(PRISMA) private readonly db!: PrismaService
  @Inject(AUDIT_SERVICE) private readonly audit!: IAuditService

  /** 权限闸门:每个端点声明它真正需要的权限点(见 access.ts)。 */
  private guard(permission: string) {
    return requirePermission(this.ctx, this.auth, this.db, permission)
  }

  private get ip(): string | null {
    return this.ctx.ip || null
  }

  // ── 角色与权限 ────────────────────────────────────────

  @Get('/rbac/permissions')
  async permissions() {
    await this.guard('rbac.read')
    return { permissions: PERMISSIONS }
  }

  @Get('/rbac/roles')
  async roles() {
    await this.guard('rbac.read')
    const rows = await this.db.client.adminRole.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { users: true } } },
    })
    return {
      roles: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        permissionKeys: parsePermissions(r.permissions),
        userCount: r._count.users,
        createdAt: ms(r.createdAt),
      })),
    }
  }

  @Post('/rbac/roles')
  async createRole(@Body() b: { name?: string; description?: string | null; permissionKeys?: unknown }) {
    const admin = await this.guard('rbac.manage')
    const name = (b?.name ?? '').trim()
    if (!name) throw new httpError.BadRequestError('name 不能为空')
    const keys = sanitizePermissionKeys(b?.permissionKeys)
    const exists = await this.db.client.adminRole.findUnique({ where: { name } })
    if (exists) throw new httpError.BadRequestError(`角色「${name}」已存在`)
    const r = await this.db.client.adminRole.create({
      data: { name, description: b?.description ?? null, permissions: JSON.stringify(keys) },
    })
    await this.audit.record({ userId: admin.id, userEmail: admin.email, ip: this.ip, action: 'rbac.role.create', detail: { roleId: r.id, name, permissionKeys: keys } })
    return { id: r.id, name: r.name, description: r.description, isSystem: r.isSystem, permissionKeys: keys, userCount: 0, createdAt: ms(r.createdAt) }
  }

  @Patch('/rbac/roles/:id')
  async updateRole(@Param('id') id: string, @Body() b: { name?: string; description?: string | null; permissionKeys?: unknown }) {
    const admin = await this.guard('rbac.manage')
    const cur = await this.db.client.adminRole.findUnique({ where: { id } })
    if (!cur) throw new httpError.NotFoundError('角色不存在')
    const data: Record<string, unknown> = {}
    if (typeof b?.name === 'string' && b.name.trim()) data.name = b.name.trim()
    if (b?.description !== undefined) data.description = b.description
    if (b?.permissionKeys !== undefined) data.permissions = JSON.stringify(sanitizePermissionKeys(b.permissionKeys))
    const r = await this.db.client.adminRole.update({ where: { id }, data, include: { _count: { select: { users: true } } } })
    await this.audit.record({ userId: admin.id, userEmail: admin.email, ip: this.ip, action: 'rbac.role.update', detail: { roleId: id, ...data } })
    return { id: r.id, name: r.name, description: r.description, isSystem: r.isSystem, permissionKeys: parsePermissions(r.permissions), userCount: r._count.users, createdAt: ms(r.createdAt) }
  }

  @Del('/rbac/roles/:id')
  async deleteRole(@Param('id') id: string) {
    const admin = await this.guard('rbac.manage')
    const r = await this.db.client.adminRole.findUnique({ where: { id }, include: { _count: { select: { users: true } } } })
    if (!r) throw new httpError.NotFoundError('角色不存在')
    // 内置角色 / 还有人在用的角色不给删 —— 删了那些人当场失去后台身份,且无法回溯是谁干的。
    if (r.isSystem) throw new httpError.BadRequestError('内置角色不能删除')
    if (r._count.users > 0) throw new httpError.BadRequestError(`还有 ${r._count.users} 人在用这个角色,先改派再删`)
    await this.db.client.adminRole.delete({ where: { id } })
    await this.audit.record({ userId: admin.id, userEmail: admin.email, ip: this.ip, action: 'rbac.role.delete', detail: { roleId: id, name: r.name } })
    return { deleted: true }
  }

  @Post('/rbac/users/:userId/role')
  async assignRole(@Param('userId') userId: string, @Body('roleId') roleId?: string | null) {
    const admin = await this.guard('rbac.manage')
    const target = await this.db.client.user.findUnique({ where: { id: userId } })
    if (!target) throw new httpError.NotFoundError('用户不存在')
    const next = roleId && roleId.trim() ? roleId.trim() : null
    if (next && !(await this.db.client.adminRole.findUnique({ where: { id: next } }))) {
      throw new httpError.BadRequestError('角色不存在')
    }
    await this.db.client.user.update({ where: { id: userId }, data: { adminRoleId: next } })
    await this.audit.record({ userId: admin.id, userEmail: admin.email, ip: this.ip, action: 'rbac.user.assign', detail: { userId, roleId: next } })
    return { userId, roleId: next }
  }

  // ── 客户端构建(软闸)────────────────────────────────

  @Get('/builds')
  async builds() {
    await this.guard('build.read')
    const rows = await this.db.client.clientBuild.findMany({ orderBy: { lastSeenAt: 'desc' } })
    // 软闸语义:**库里存在任一 allowed 才开始强制**,否则一律放行 ——
    // 免得刚上线一条记录都还没审批,就把所有客户端挡在门外。
    const enforcing = rows.some((r) => r.status === 'allowed')
    return {
      builds: rows.map((r) => ({
        id: r.id, sha256: r.sha256, version: r.version ?? '', platform: r.platform ?? '', arch: r.arch ?? '',
        status: r.status, loginCount: r.loginCount, firstSeenAt: ms(r.firstSeenAt), lastSeenAt: ms(r.lastSeenAt),
      })),
      enforcing,
    }
  }

  @Patch('/builds/:id/status')
  async setBuildStatus(@Param('id') id: string, @Body('status') status: string) {
    const admin = await this.guard('build.manage')
    if (!BUILD_STATUSES.includes(status as (typeof BUILD_STATUSES)[number])) {
      throw new httpError.BadRequestError(`未知状态:${status}(只能是 ${BUILD_STATUSES.join(' / ')})`)
    }
    const exists = await this.db.client.clientBuild.findUnique({ where: { id } })
    if (!exists) throw new httpError.NotFoundError('构建记录不存在')
    const r = await this.db.client.clientBuild.update({ where: { id }, data: { status } })
    await this.audit.record({ userId: admin.id, userEmail: admin.email, ip: this.ip, action: 'client_build.status', detail: { id, status, sha256: r.sha256 } })
    return {
      id: r.id, sha256: r.sha256, version: r.version ?? '', platform: r.platform ?? '', arch: r.arch ?? '',
      status: r.status, loginCount: r.loginCount, firstSeenAt: ms(r.firstSeenAt), lastSeenAt: ms(r.lastSeenAt),
    }
  }

  // ── 审计日志 ──────────────────────────────────────────

  @Get('/audits')
  async audits(@Query('page') page?: string) {
    await this.guard('audit.read')
    const p = Math.max(1, Number(page ?? 1))
    const [rows, total] = await Promise.all([
      this.db.client.auditLog.findMany({ orderBy: { createdAt: 'desc' }, skip: (p - 1) * PAGE_SIZE, take: PAGE_SIZE }),
      this.db.client.auditLog.count(),
    ])
    return {
      items: rows.map((a) => ({ id: a.id, userEmail: a.userEmail, action: a.action, detail: a.detail, ip: a.ip, createdAt: ms(a.createdAt) })),
      total, page: p, pageSize: PAGE_SIZE,
    }
  }

  // ── 注册管控 ──────────────────────────────────────────

  private async regMode(): Promise<RegMode> {
    const row = await this.db.client.systemSetting.findUnique({ where: { key: REG_MODE_KEY } })
    const v = row?.value as RegMode | undefined
    return v && REG_MODES.includes(v) ? v : 'open'
  }

  @Get('/registration')
  async registration(@Query('page') page?: string) {
    await this.guard('user.read')
    const p = Math.max(1, Number(page ?? 1))
    const now = Date.now()
    const dayAgo = new Date(now - 24 * 3600 * 1000)
    const weekAgo = new Date(now - 7 * 24 * 3600 * 1000)

    const [mode, today, week, rows, total, totalUsers, subscribed] = await Promise.all([
      this.regMode(),
      this.db.client.user.count({ where: { createdAt: { gte: dayAgo } } }),
      this.db.client.user.count({ where: { createdAt: { gte: weekAgo } } }),
      this.db.client.user.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (p - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: { id: true, email: true, inviteCode: true, signupIp: true, signupDevice: true, disabled: true, createdAt: true },
      }),
      this.db.client.user.count(),
      this.db.client.user.count(),
      this.db.client.subscription.count({ where: { status: 'active' } }),
    ])

    // 可疑判定:**同一 IP 注册了多个账号**是最有信号的一条(批量注册的典型形状)。
    // 规则放服务端,客户端只显示结论 —— 免得规则被扒走后绕过。
    const ips = [...new Set(rows.map((r) => r.signupIp).filter((v): v is string => Boolean(v)))]
    const ipCounts = new Map<string, number>()
    for (const ip of ips) {
      ipCounts.set(ip, await this.db.client.user.count({ where: { signupIp: ip } }))
    }

    return {
      mode,
      today,
      week,
      conversion: totalUsers > 0 ? Math.round((subscribed / totalUsers) * 100) : 0,
      total,
      items: rows.map((u) => {
        const dup = u.signupIp ? (ipCounts.get(u.signupIp) ?? 1) : 1
        return {
          id: u.id,
          email: u.email,
          inviteCode: u.inviteCode,
          ip: u.signupIp,
          device: u.signupDevice,
          suspicious: dup > 2,
          suspicionNote: dup > 2 ? `同 IP 已注册 ${dup} 个账号` : null,
          disabled: u.disabled,
          createdAt: ms(u.createdAt),
        }
      }),
    }
  }

  @Patch('/registration/mode')
  async setRegMode(@Body('mode') mode: string) {
    const admin = await this.guard('user.manage')
    if (!REG_MODES.includes(mode as RegMode)) {
      throw new httpError.BadRequestError(`未知模式:${mode}(只能是 ${REG_MODES.join(' / ')})`)
    }
    await this.db.client.systemSetting.upsert({
      where: { key: REG_MODE_KEY },
      create: { key: REG_MODE_KEY, value: mode },
      update: { value: mode },
    })
    await this.audit.record({ userId: admin.id, userEmail: admin.email, ip: this.ip, action: 'registration.mode', detail: { mode } })
    return { mode }
  }
}
