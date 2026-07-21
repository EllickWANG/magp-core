import { Body, Controller, Del, Get, httpError, Inject, Param, Patch, Post, Query } from '@midwayjs/core'
import { Context } from '@midwayjs/koa'
import { PRISMA, PrismaService } from '../../database/prisma.service.js'
import { decryptSecret, encryptSecret } from '../../database/crypto.js'
import { AUTH_SERVICE, type IAuthService } from '../app/auth/auth.contract.js'
import { AUDIT_SERVICE, type IAuditService } from './audit.service.js'
import { requirePermission } from './access.js'
import { probeProvider } from './provider-probe.js'
import { PROVIDER_PRESETS } from './provider-presets.js'

const CAPS = ['llm', 'vision', 'image', 'video'] as const
const PAGE_SIZE = 20
const ms = (d: Date | null) => (d ? d.getTime() : null)
const dayKey = (d: Date): string =>
  `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** 环比百分比;**上一期为 0 时返回 null** —— 从 0 涨到任何数都不是"增长 100%",那是无意义的分母。 */
const pct = (cur: number, prev: number): number | null =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null

/**
 * CMS 管理端(core 重设计后的干净契约,cms 前端按此对接)。
 * 响应经 ResponseWrapMiddleware 包 {success,data};admin 守卫;provider 列表不含明文密钥。
 * 说明:core 重设计砍掉了 RBAC角色表/设备/构建/审计/权益,故不提供 roles/builds/audits/entitlements/devices。
 */
@Controller('/api/cms')
export class CmsController {
  @Inject() ctx!: Context
  @Inject(AUTH_SERVICE) private readonly auth!: IAuthService
  @Inject(PRISMA) private readonly db!: PrismaService
  @Inject(AUDIT_SERVICE) private readonly audit!: IAuditService

  /**
   * 权限闸门 —— 每个端点标注**它真正需要的权限点**,而不是笼统的"是不是管理员"。
   * 超管(role==='admin')恒定全权限,受托管理员按其角色勾选的权限点放行(见 access.ts)。
   */
  private guard(permission: string) {
    return requirePermission(this.ctx, this.auth, this.db, permission)
  }

  /** 记一条审计:谁(admin)、从哪(ip)、做了什么。**只在业务成功之后调**。 */
  private async log(admin: { id: string; email: string }, action: string, detail?: unknown): Promise<void> {
    await this.audit.record({ userId: admin.id, userEmail: admin.email, ip: this.ctx.ip || null, action, detail })
  }

  // ── 概览 ──────────────────────────────────────────────
  /**
   * 概览 —— **全部字段都是真算的**,没有占位。
   *
   * 之前这页下半屏(日用量柱、套餐分布、最近审计)是写死的假数据,于是出现了
   * 上面磁贴写「活跃订阅 0」、下面却写「312 个活跃订阅 · 专业版 186」这种**自相矛盾**的屏。
   * 后台的价值就是让人据此判断,数字一旦是编的,这页就成了负资产。
   */
  @Get('/overview')
  async overview() {
    await this.guard('usage.read')
    const now = Date.now()
    const DAY = 24 * 3600 * 1000
    const d7 = new Date(now - 7 * DAY)
    const d30 = new Date(now - 30 * DAY)
    const d60 = new Date(now - 60 * DAY)

    const [
      totalUsers, newUsers7d, activeSubscriptions, newSubs30d,
      events30d, eventsPrev30d, agg, aggPrev,
      series, activeSubs, recentAudits,
    ] = await Promise.all([
      this.db.client.user.count(),
      this.db.client.user.count({ where: { createdAt: { gte: d7 } } }),
      this.db.client.subscription.count({ where: { status: 'active' } }),
      this.db.client.subscription.count({ where: { createdAt: { gte: d30 } } }),
      this.db.client.usageEvent.count({ where: { createdAt: { gte: d30 } } }),
      this.db.client.usageEvent.count({ where: { createdAt: { gte: d60, lt: d30 } } }),
      this.db.client.usageEvent.aggregate({ where: { createdAt: { gte: d30 } }, _sum: { inputTokens: true, outputTokens: true, totalTokens: true } }),
      this.db.client.usageEvent.aggregate({ where: { createdAt: { gte: d60, lt: d30 } }, _sum: { totalTokens: true } }),
      // 日序列:sqlite 没有 date_trunc,取回 (时间, token) 两列在内存分桶 —— 只取这两列,不拉整行。
      this.db.client.usageEvent.findMany({ where: { createdAt: { gte: d30 } }, select: { createdAt: true, totalTokens: true } }),
      this.db.client.subscription.findMany({ where: { status: 'active' }, select: { plan: { select: { code: true, name: true } } } }),
      this.db.client.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 6 }),
    ])

    // ── 近 30 天按日:补齐没有事件的那些天(缺口不能省,省了图会把时间轴压缩得看不出停顿)
    const buckets = new Map<string, number>()
    for (let i = 29; i >= 0; i -= 1) buckets.set(dayKey(new Date(now - i * DAY)), 0)
    for (const e of series) {
      const k = dayKey(e.createdAt)
      if (buckets.has(k)) buckets.set(k, (buckets.get(k) ?? 0) + (e.totalTokens ?? 0))
    }
    const daily = [...buckets.entries()].map(([date, tokens]) => ({ date, tokens }))

    // ── 套餐分布:按活跃订阅的套餐归类
    const byPlan = new Map<string, { code: string; name: string; count: number }>()
    for (const s of activeSubs) {
      const cur = byPlan.get(s.plan.code) ?? { code: s.plan.code, name: s.plan.name, count: 0 }
      cur.count += 1
      byPlan.set(s.plan.code, cur)
    }
    const plans = [...byPlan.values()]
      .sort((a, b) => b.count - a.count)
      .map((p) => ({ ...p, pct: activeSubscriptions > 0 ? Math.round((p.count / activeSubscriptions) * 100) : 0 }))

    return {
      totalUsers,
      activeSubscriptions,
      events30d,
      inputTokens30d: agg._sum.inputTokens ?? 0,
      outputTokens30d: agg._sum.outputTokens ?? 0,
      totalTokens30d: agg._sum.totalTokens ?? 0,
      /** 涨跌:**算得出来才给,算不出来给 null**(前端据此不显示,而不是编一个数)。 */
      deltas: {
        newUsers7d,
        newSubs30d,
        eventsPct: pct(events30d, eventsPrev30d),
        tokensPct: pct(agg._sum.totalTokens ?? 0, aggPrev._sum.totalTokens ?? 0),
      },
      daily,
      todayTokens: daily[daily.length - 1]?.tokens ?? 0,
      plans,
      recentAudits: recentAudits.map((a) => ({
        id: a.id, action: a.action, userEmail: a.userEmail, detail: a.detail, createdAt: ms(a.createdAt),
      })),
    }
  }

  @Get('/users')
  async users(@Query('keyword') keyword?: string, @Query('page') page?: string) {
    await this.guard('user.read')
    const p = Math.max(1, Number(page ?? 1))
    const where = keyword ? { email: { contains: keyword } } : {}
    const [rows, total] = await Promise.all([
      this.db.client.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (p - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        // adminRoleId:后台角色的**当前指派**。列表不带它的话,前端的角色下拉框就只能是个
        // 不知道当前值的空壳 —— 指派入口(POST /rbac/users/:userId/role)因此一直没法接。
        select: { id: true, email: true, name: true, role: true, disabled: true, createdAt: true, adminRoleId: true },
      }),
      this.db.client.user.count({ where }),
    ])
    return { items: rows.map((u) => ({ ...u, createdAt: ms(u.createdAt) })), total, page: p, pageSize: PAGE_SIZE }
  }

  /**
   * 用户详情(点行打开的抽屉)—— 订阅历史 + 令牌与会话。
   *
   * **这里只给后端真有的两块**。设计稿抽屉里还有「设备」和「工具调用(近24H)」:
   * 设备表存在但没有任何代码往里写(登录侧还没登记),工具调用 core 压根没有这张表 ——
   * 都做成 UI 就又是"对着操作者撒谎"。等各自的链路打通了再加。
   */
  @Get('/users/:id/detail')
  async userDetail(@Param('id') id: string) {
    await this.guard('user.read')
    const user = await this.db.client.user.findUnique({ where: { id } })
    if (!user) throw new httpError.NotFoundError('用户不存在')

    const [subs, counters, tokens, lastToken] = await Promise.all([
      // 换套餐 = 开新订阅、旧的置 ended,所以历史是一串而不是一行 —— 按开始时间倒序就是时间线。
      this.db.client.subscription.findMany({
        where: { userId: id },
        include: { plan: true },
        orderBy: { periodStart: 'desc' },
      }),
      this.db.client.usageCounter.findMany({ where: { userId: id }, orderBy: { periodStart: 'desc' }, take: 12 }),
      this.db.client.authToken.count({ where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } } }),
      this.db.client.authToken.findFirst({ where: { userId: id }, orderBy: { createdAt: 'desc' } }),
    ])

    // 用量按周期对齐到订阅上:抽屉里「本周期已用 x / y」要的就是这个。
    const usageAt = (start: Date): { used: number; limit: number } | null => {
      const c = counters.find((x) => Math.abs(x.periodStart.getTime() - start.getTime()) < 36e5)
      return c ? { used: c.usedTokens, limit: c.limitTokens } : null
    }

    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role, disabled: user.disabled, createdAt: ms(user.createdAt) },
      subscriptions: subs.map((x) => ({
        id: x.id,
        planName: x.plan.name,
        planCode: x.plan.code,
        status: x.status,
        periodStart: ms(x.periodStart),
        periodEnd: ms(x.periodEnd),
        monthlyTokens: x.plan.monthlyTokens,
        usage: usageAt(x.periodStart),
      })),
      tokens: {
        active: tokens,
        lastLoginAt: lastToken ? ms(lastToken.createdAt) : null,
        lastLoginIp: lastToken?.ip ?? null,
      },
    }
  }

  /**
   * 吊销该用户全部令牌 —— 即时踢下线(access token 15 分钟内自然过期,refresh 立即失效)。
   * 停用用户时也会自动调它:界面上写着"停用会即时吊销全部令牌并踢下线",那句话得是真的。
   */
  @Post('/users/:id/tokens/revoke')
  async revokeUserTokens(@Param('id') id: string) {
    const admin = await this.guard('user.manage')
    const n = await this.revokeAllTokens(id)
    await this.log(admin, 'user.tokens_revoke', { userId: id, revoked: n })
    return { revoked: n }
  }

  /** 把该用户所有未吊销的令牌打上 revokedAt。**不删行** —— 审计要能对回来。 */
  private async revokeAllTokens(userId: string): Promise<number> {
    const r = await this.db.client.authToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    return r.count
  }

  @Patch('/users/:id/disabled')
  async setUserDisabled(@Param('id') id: string, @Body('disabled') disabled: boolean) {
    const admin = await this.guard('user.manage')
    const u = await this.db.client.user.update({ where: { id }, data: { disabled } })
    // **停用必须同时吊销令牌**,否则"停用"只挡住下次登录 —— 他当前那台机器照样跑,
    // 而你在后台看到的是"已停用",以为人已经下线了。这正是界面承诺的那句话。
    const revoked = disabled ? await this.revokeAllTokens(id) : 0
    await this.log(admin, disabled ? 'user.disable' : 'user.enable', { userId: id, email: u.email, revokedTokens: revoked })
    return { id, disabled, revokedTokens: revoked }
  }

  @Patch('/users/:id/role')
  async setUserRole(@Param('id') id: string, @Body('role') role: string) {
    const admin = await this.guard('user.manage')
    if (role !== 'admin' && role !== 'user') throw new httpError.BadRequestError('role 只能是 admin|user')
    const u = await this.db.client.user.update({ where: { id }, data: { role } })
    await this.log(admin, 'user.role', { userId: id, email: u.email, role })
    return { id, role }
  }

  // ── 套餐 ──────────────────────────────────────────────
  @Get('/plans')
  async plans() {
    await this.guard('plan.read')
    const rows = await this.db.client.plan.findMany({ orderBy: { createdAt: 'asc' }, include: { _count: { select: { subscriptions: true } } } })
    return rows.map((p) => ({
      id: p.id, code: p.code, name: p.name, priceCents: p.priceCents, currency: p.currency,
      monthlyTokens: p.monthlyTokens, maxDevices: p.maxDevices, active: p.active, subscribers: p._count.subscriptions,
    }))
  }

  @Post('/plans')
  async createPlan(@Body() b: { code: string; name: string; monthlyTokens: number; priceCents?: number }) {
    await this.guard('plan.manage')
    const p = await this.db.client.plan.create({ data: { code: b.code, name: b.name, monthlyTokens: b.monthlyTokens, priceCents: b.priceCents ?? 0 } })
    return p
  }

  @Patch('/plans/:id')
  async updatePlan(@Param('id') id: string, @Body() b: Record<string, unknown>) {
    await this.guard('plan.manage')
    const data: Record<string, unknown> = {}
    for (const k of ['name', 'priceCents', 'monthlyTokens', 'maxDevices', 'active'] as const) if (k in b) data[k] = b[k]
    return this.db.client.plan.update({ where: { id }, data })
  }

  // ── 工具策略 ──────────────────────────────────────────
  @Get('/tool-policies')
  async toolPolicies() {
    await this.guard('toolpolicy.read')
    const rows = await this.db.client.toolPolicy.findMany({ orderBy: [{ scope: 'asc' }, { priority: 'desc' }] })
    return { policies: rows.map((t) => ({ ...t, createdAt: ms(t.createdAt) })) }
  }

  @Post('/tool-policies')
  async createToolPolicy(@Body() b: { scope: string; toolPattern: string; effect: string; userId?: string; planId?: string; priority?: number }) {
    await this.guard('toolpolicy.manage')
    const t = await this.db.client.toolPolicy.create({
      data: { scope: b.scope, toolPattern: b.toolPattern, effect: b.effect, userId: b.userId ?? null, planId: b.planId ?? null, priority: b.priority ?? 0 },
    })
    return { id: t.id }
  }

  @Patch('/tool-policies/:id')
  async updateToolPolicy(@Param('id') id: string, @Body() b: Record<string, unknown>) {
    await this.guard('toolpolicy.manage')
    const data: Record<string, unknown> = {}
    for (const k of ['toolPattern', 'effect', 'priority', 'active'] as const) if (k in b) data[k] = b[k]
    await this.db.client.toolPolicy.update({ where: { id }, data })
    return { id }
  }

  @Del('/tool-policies/:id')
  async deleteToolPolicy(@Param('id') id: string) {
    await this.guard('toolpolicy.manage')
    await this.db.client.toolPolicy.delete({ where: { id } })
    return { deleted: true }
  }

  // ── 服务商(模型路由)────────────────────────────────
  @Get('/providers')
  async providers() {
    await this.guard('provider.read')
    const [rows, assigns] = await Promise.all([
      this.db.client.provider.findMany({ orderBy: { createdAt: 'asc' } }),
      this.db.client.providerAssignment.findMany(),
    ])
    const assignedBy = new Map<string, string[]>()
    const assignments: Record<string, string | null> = { llm: null, vision: null, image: null, video: null }
    for (const a of assigns) {
      assignments[a.capability] = a.providerId
      assignedBy.set(a.providerId, [...(assignedBy.get(a.providerId) ?? []), a.capability])
    }
    const providers = rows.map((p) => ({
      id: p.id, code: p.code, name: p.name, baseUrl: p.baseUrl, apiFormat: p.apiFormat,
      models: safeJson(p.models), capabilities: safeJson(p.capabilities),
      apiKeyMask: '••••••••', assignedTo: assignedBy.get(p.id) ?? [],
    }))
    return { providers, assignments }
  }

  /**
   * 厂商/协议预设 —— 新建服务商时先选它,协议格式由它定死(见 provider-presets.ts)。
   * **必须放在 /providers/:id 之前**?这里没有 GET /providers/:id,故无歧义。
   */
  @Get('/providers/presets')
  async providerPresets() {
    await this.guard('provider.read')
    return PROVIDER_PRESETS
  }

  @Post('/providers')
  async createProvider(@Body() b: { code?: string; name: string; baseUrl: string; apiKey: string; apiFormat?: string; models?: object; capabilities?: string[] }) {
    const admin = await this.guard('provider.manage')
    const input = await this.normalizeProviderInput(b)
    // code 是库里的稳定标识(审计/日志都靠它对回来),但**不该让人手填** —— 界面上多一个
    // 说不清用途的字段,只会被随手填成和 name 一样。没给就按 p-xxxx 生成。
    const code = (b.code ?? '').trim() || (await this.newProviderCode())
    const p = await this.db.client.provider.create({
      data: {
        code,
        name: input.name,
        baseUrl: input.baseUrl,
        apiFormat: input.apiFormat,
        models: JSON.stringify(b.models ?? {}),
        capabilities: JSON.stringify(input.capabilities),
        apiKeyEnc: encryptSecret(input.apiKey),
      },
    })
    await this.log(admin, 'provider.create', { providerId: p.id, code, name: input.name, apiFormat: input.apiFormat })
    return { id: p.id, code: p.code }
  }

  /** 校验并规整新建入参 —— 空格、缺字段、非法 URL 都在这里挡住,别让它变成一句 Prisma 报错。 */
  private async normalizeProviderInput(b: {
    name?: string; baseUrl?: string; apiKey?: string; apiFormat?: string; capabilities?: string[]
  }): Promise<{ name: string; baseUrl: string; apiKey: string; apiFormat: string; capabilities: string[] }> {
    const name = (b.name ?? '').trim()
    if (!name) throw new httpError.BadRequestError('名称不能为空')
    const baseUrl = (b.baseUrl ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(baseUrl)) throw new httpError.BadRequestError('Base URL 必须是完整的 http/https 地址')
    const apiKey = (b.apiKey ?? '').trim()
    if (!apiKey) throw new httpError.BadRequestError('API 密钥不能为空')
    const apiFormat = (b.apiFormat ?? 'openai_chat').trim()
    const capabilities = (b.capabilities ?? []).filter((c) => CAPS.includes(c as (typeof CAPS)[number]))
    if (capabilities.length === 0) throw new httpError.BadRequestError('至少要勾一个能力(否则这个服务商没法被指派)')
    return { name, baseUrl, apiKey, apiFormat, capabilities }
  }

  /** 生成不冲突的 provider code(沿用库里已有的 p-xxxx 形状)。 */
  private async newProviderCode(): Promise<string> {
    for (let i = 0; i < 6; i += 1) {
      const code = `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`
      if (!(await this.db.client.provider.findUnique({ where: { code } }))) return code
    }
    throw new httpError.BadRequestError('生成服务商编码失败,请重试')
  }

  @Patch('/providers/:id')
  async updateProvider(@Param('id') id: string, @Body() b: Record<string, unknown>) {
    const admin = await this.guard('provider.manage')
    const data: Record<string, unknown> = {}
    for (const k of ['name', 'baseUrl', 'apiFormat'] as const) {
      if (k in b && typeof b[k] === 'string') data[k] = (b[k] as string).trim()
    }
    if (typeof data.baseUrl === 'string') data.baseUrl = (data.baseUrl as string).replace(/\/+$/, '')
    if (b.models) data.models = JSON.stringify(b.models)
    if (b.capabilities) data.capabilities = JSON.stringify(b.capabilities)
    // 密钥轮换:**留空 = 不换**(前端占位就是这么写的),别把空串当成"清空密钥"。
    const rotated = typeof b.apiKey === 'string' && b.apiKey.trim().length > 0
    if (rotated) data.apiKeyEnc = encryptSecret((b.apiKey as string).trim())
    await this.db.client.provider.update({ where: { id }, data })
    await this.log(admin, 'provider.update', { providerId: id, fields: Object.keys(data), keyRotated: rotated })
    return { id }
  }

  @Del('/providers/:id')
  async deleteProvider(@Param('id') id: string) {
    const admin = await this.guard('provider.manage')
    const p = await this.db.client.provider.findUnique({ where: { id } })
    if (!p) throw new httpError.NotFoundError()
    await this.db.client.provider.delete({ where: { id } })
    await this.log(admin, 'provider.delete', { providerId: id, code: p.code, name: p.name })
    return { id }
  }

  /** 取密钥明文 —— 仅管理员点「显示」时调。 */
  @Post('/providers/:id/reveal')
  async revealProviderKey(@Param('id') id: string) {
    const admin = await this.guard('provider.reveal')
    const p = await this.db.client.provider.findUnique({ where: { id } })
    if (!p) throw new httpError.NotFoundError()
    // 密钥明文被看过一次,就永远算"可能已泄露"—— 这条必须留痕。
    await this.log(admin, 'provider.key_reveal', { providerId: id, code: p.code })
    return { id, apiKey: decryptSecret(p.apiKeyEnc) }
  }

  /**
   * 探活 —— 用**这个服务商自己配的协议和模型**真打一次上游。改完配置一定点它。
   * 结果分两段(连通 / 模型往返),因为坏起来的样子完全不同(见 provider-probe.ts)。
   */
  @Post('/providers/:id/test')
  async testProvider(@Param('id') id: string) {
    const admin = await this.guard('provider.test')
    const p = await this.db.client.provider.findUnique({ where: { id } })
    if (!p) throw new httpError.NotFoundError()
    const report = await probeProvider({
      baseURL: p.baseUrl,
      apiKey: decryptSecret(p.apiKeyEnc),
      apiFormat: p.apiFormat,
      capabilities: (safeArr(p.capabilities) as string[]) ?? ['llm'],
      models: (safeObj(p.models) as Record<string, string>) ?? {},
    })
    await this.log(admin, 'provider.test', { providerId: id, code: p.code, ok: report.ok })
    return report
  }

  /** 指派某能力给某服务商(providerId=null 解除)。返回全量 assignments。 */
  @Post('/providers/assign')
  async assignProvider(@Body('capability') capability: string, @Body('providerId') providerId: string | null) {
    await this.guard('provider.manage')
    if (!CAPS.includes(capability as (typeof CAPS)[number])) throw new httpError.BadRequestError('未知能力')
    if (providerId) {
      await this.db.client.providerAssignment.upsert({ where: { capability }, create: { capability, providerId }, update: { providerId } })
    } else {
      await this.db.client.providerAssignment.deleteMany({ where: { capability } })
    }
    const all = await this.db.client.providerAssignment.findMany()
    const assignments: Record<string, string | null> = { llm: null, vision: null, image: null, video: null }
    for (const a of all) assignments[a.capability] = a.providerId
    return assignments
  }

  // ── 用量 ──────────────────────────────────────────────
  @Get('/usage/events')
  async usageEvents(@Query('page') page?: string, @Query('userId') userId?: string) {
    await this.guard('usage.read')
    const p = Math.max(1, Number(page ?? 1))
    const where = userId ? { userId } : {}
    const [rows, total] = await Promise.all([
      this.db.client.usageEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (p - 1) * PAGE_SIZE, take: PAGE_SIZE, include: { user: { select: { email: true } } } }),
      this.db.client.usageEvent.count({ where }),
    ])
    return {
      items: rows.map((e) => ({ id: e.id, userEmail: e.user.email, provider: e.provider, model: e.model, inputTokens: e.inputTokens, outputTokens: e.outputTokens, totalTokens: e.totalTokens, status: e.status, createdAt: ms(e.createdAt) })),
      total, page: p, pageSize: PAGE_SIZE,
    }
  }
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

const safeObj = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
const safeArr = (s: string): unknown => {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
