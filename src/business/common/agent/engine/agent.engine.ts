import { Inject, Provide, Scope, ScopeEnum } from '@midwayjs/core'
import type { AgentEvent } from '../domain/index.js'
import { MODEL_PROVIDER, type IModelProvider } from '../model/model.contract.js'
import { TOOL_REGISTRY, CAPABILITY, type ICapability, type IToolRegistry } from '../tools/tool.contract.js'
import { PERMISSION, type IPermission } from '../permission/permission.contract.js'
import { CLIENT_CHANNEL, type IClientChannel } from '../session/channel.contract.js'
import { AGENT_ENGINE, type AgentRunSpec, type IAgentEngine, type SessionInput } from './agent.contract.js'
import { runSession } from './session.js'

/**
 * agent 引擎(Midway 组件)。只 @Inject 各模块的【接口 token】,不认实现。
 * 换模型/工具/权限/通道 = 换绑到 token 的实现类,本文件一行不动。
 * 纯循环逻辑在 turn.ts/session.ts(可脱离 Midway 单测);这里只做 DI 装配。
 */
@Provide(AGENT_ENGINE)
@Scope(ScopeEnum.Singleton)
export class AgentEngine implements IAgentEngine {
  @Inject(MODEL_PROVIDER) private readonly model!: IModelProvider
  @Inject(PERMISSION) private readonly permission!: IPermission
  @Inject(TOOL_REGISTRY) private readonly tools!: IToolRegistry
  @Inject(CAPABILITY) private readonly capability!: ICapability
  @Inject(CLIENT_CHANNEL) private readonly channel!: IClientChannel

  async *runSession(spec: AgentRunSpec, input: SessionInput): AsyncGenerator<AgentEvent> {
    yield* runSession(
      {
        meta: spec.meta,
        system: spec.system,
        messages: spec.messages,
        newId: spec.newId,
        maxSteps: spec.maxSteps,
        model: this.model,
        permission: this.permission,
        tools: this.tools,
        capability: this.capability,
        channel: this.channel,
      },
      input,
    )
  }
}
