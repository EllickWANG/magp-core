import { Inject, Provide, Scope, ScopeEnum } from '@midwayjs/core'
import { PRISMA, PrismaService } from '../../../database/prisma.service.js'
import {
  PERMISSION,
  type IPermission,
  type PermissionDecision,
} from '../../common/agent/permission/permission.contract.js'
import type { TurnMeta } from '../../common/agent/domain/index.js'

/**
 * 业务实现 agent 的 PERMISSION:ToolPolicy 解析(user > global,priority 大者先,首条命中)。
 * headless 下 ask 视同 deny(无交互确认)。无策略默认放行。
 * TODO: 接 plan 层(需 user 的当前订阅)、pattern 更严格的通配。
 */
@Provide(PERMISSION)
@Scope(ScopeEnum.Singleton)
export class ToolPolicyPermission implements IPermission {
  @Inject(PRISMA) private readonly db!: PrismaService

  async check(input: { tool: string; args: unknown; meta: TurnMeta; signal: AbortSignal }): Promise<PermissionDecision> {
    const policies = await this.db.client.toolPolicy.findMany({
      where: {
        active: true,
        OR: [{ scope: 'global' }, { scope: 'user', userId: input.meta.userId }],
      },
      orderBy: [{ scope: 'desc' }, { priority: 'desc' }], // user > global(字典序 user>global 成立),同层 priority
    })
    const hit = policies.find((p) => matchPattern(p.toolPattern, input.tool))
    if (!hit) return { allow: true }
    if (hit.effect === 'allow') return { allow: true }
    return { allow: false, reason: `tool policy: ${hit.effect} (${hit.toolPattern})` }
  }
}

/** 支持前缀通配:Bash / browser_* / mcp__magp__* */
function matchPattern(pattern: string, tool: string): boolean {
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1))
  return pattern === tool
}
