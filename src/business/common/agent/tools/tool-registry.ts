import { Provide, Scope, ScopeEnum } from '@midwayjs/core'
import { z } from 'zod'
import type { TurnMeta } from '../domain/index.js'
import { TOOL_REGISTRY, type ITool, type IToolRegistry } from './tool.contract.js'
import { CLIENT_TOOLS } from './client-tools.js'

/**
 * IToolRegistry 的实现:持有全部工具,按会话过滤 + 生成给模型的 spec(zod→JSON Schema)。
 * 工具目录见 client-tools.ts(agent 的真实手和眼:浏览器/看板/画布/简报…)。引擎只认 IToolRegistry,不认具体工具。
 */
const TOOLS: ITool[] = [...CLIENT_TOOLS]

@Provide(TOOL_REGISTRY)
@Scope(ScopeEnum.Singleton)
export class AgentToolRegistry implements IToolRegistry {
  private readonly map = new Map<string, ITool>(TOOLS.map((t) => [t.name, t]))

  get(name: string): ITool | undefined {
    return this.map.get(name)
  }
  enabled(meta: TurnMeta): ITool[] {
    return [...this.map.values()].filter((t) => t.isEnabled(meta))
  }
  enabledSpecs(meta: TurnMeta): { name: string; description: string; parameters: unknown }[] {
    return this.enabled(meta).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.inputSchema),
    }))
  }
}
