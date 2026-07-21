import type { AgentEvent, ContentPart, Message, TurnMeta } from '../domain/index.js'
import type { IModelProvider } from '../model/model.contract.js'
import type { ICapability, IToolRegistry } from '../tools/tool.contract.js'
import type { IPermission } from '../permission/permission.contract.js'
import type { IClientChannel } from '../session/channel.contract.js'

export const AGENT_ENGINE = 'agent:engine'

/** 一轮/一会话的运行上下文:引擎只认接口,不认实现。 */
export interface RunCtx {
  readonly meta: TurnMeta
  readonly system: string
  readonly messages: Message[]
  readonly tools: IToolRegistry
  readonly model: IModelProvider
  readonly permission: IPermission
  readonly capability: ICapability
  readonly channel: IClientChannel
  readonly newId: () => string
  readonly signal: AbortSignal
  readonly maxSteps: number
}

export interface UserTurnInput {
  readonly content: readonly ContentPart[] | string
}

export interface SessionInput {
  next(signal: AbortSignal): Promise<UserTurnInput | null>
  readonly signal: AbortSignal
}

/** 会话级运行参数(会话特有部分;四件套依赖由引擎从 DI 注入,调用方不传)。 */
export interface AgentRunSpec {
  readonly meta: TurnMeta
  readonly system: string
  readonly messages: Message[]
  readonly newId: () => string
  readonly maxSteps: number
}

export interface IAgentEngine {
  runSession(spec: AgentRunSpec, input: SessionInput): AsyncGenerator<AgentEvent>
}
