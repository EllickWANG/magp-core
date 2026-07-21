import { Inject, Provide, Scope, ScopeEnum } from '@midwayjs/core'
import {
  MODEL_CONFIG_SOURCE,
  type IModelConfigSource,
  type ModelConfig,
} from '../../common/agent/model/model-config.contract.js'
import type { TurnMeta } from '../../common/agent/domain/index.js'
import { PROVIDER_REGISTRY, type IProviderRegistry } from './provider.contract.js'

/**
 * 业务实现 agent 的 MODEL_CONFIG_SOURCE:模型 provider 纯从 CMS(provider 域)取。
 * 未在 CMS 指派 llm 服务商时抛错 —— 配置在 CMS,不回落 env。
 */
@Provide(MODEL_CONFIG_SOURCE)
@Scope(ScopeEnum.Singleton)
export class ModelConfigProvider implements IModelConfigSource {
  @Inject(PROVIDER_REGISTRY) private readonly providers!: IProviderRegistry

  async resolve(_meta: TurnMeta): Promise<ModelConfig> {
    // TODO: 可按 _meta.userId 做用户级 provider 路由;现取全局 llm 指派。
    const p = await this.providers.resolve('llm')
    if (!p || !p.apiKey) throw new Error('未在 CMS 指派 llm 服务商(/api/cms/providers + assign)')
    return { baseURL: p.baseURL, apiKey: p.apiKey, model: p.model, apiFormat: p.apiFormat }
  }
}
