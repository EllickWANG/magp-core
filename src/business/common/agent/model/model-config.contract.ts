import type { TurnMeta } from '../domain/index.js'

/** 模型配置源:由业务(provider 域,CMS 投影)提供当前 llm provider 的连接配置。 */
export const MODEL_CONFIG_SOURCE = 'agent:model-config-source'

export interface ModelConfig {
  baseURL: string
  apiKey: string
  model: string
  /** 上游协议,决定用哪套请求/流式格式(见 model/protocols/)。 */
  apiFormat: string
}

export interface IModelConfigSource {
  /** 解析当前会话该用的 llm provider(可按 meta.userId 做用户级路由;CMS 变更即时生效)。 */
  resolve(meta: TurnMeta): Promise<ModelConfig>
}
