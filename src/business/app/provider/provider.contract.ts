/** provider 域(模型路由)对外接口。 */
export const PROVIDER_REGISTRY = 'app:provider-registry'

/**
 * 能力槽 —— 系统是**多模型**的:每种能力指派最擅长它的服务商。
 *
 * 注:曾经拆过一个独立的 grounding(视觉定位)槽,后来去掉了 —— 实测 vision 模型
 * (claude-opus-4-8)在**被要求返回 bbox JSON** 时定位误差 0~1px,6/6 命中。
 * 之前"视觉定位不准"的根子在**问法**(要散文描述 vs 要结构化 bbox),不在模型档次,
 * 所以多一个槽只是多一份配置负担。定位直接用 vision 那家。
 */
export type Capability = 'llm' | 'vision' | 'image' | 'video'

export interface ResolvedProvider {
  code: string
  baseURL: string
  apiKey: string
  model: string
  /** 上游协议:anthropic | openai_chat | openai_responses | deepseek_chat。**必须带上** ——
   *  少了它就只能一律当 OpenAI Chat 调,配了 claude 原生协议的服务商会一路失败,
   *  而界面上只表现为「agent 不回话」。 */
  apiFormat: string
}

export interface IProviderRegistry {
  /** 解析指派给某能力的 provider(已解密 + 选出对应模型名)。无指派返回 null。 */
  resolve(capability: Capability): Promise<ResolvedProvider | null>
}
