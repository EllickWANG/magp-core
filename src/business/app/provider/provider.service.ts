import { Inject, Provide, Scope, ScopeEnum } from '@midwayjs/core'
import { PRISMA, PrismaService } from '../../../database/prisma.service.js'
import { decryptSecret } from '../../../database/crypto.js'
import {
  PROVIDER_REGISTRY,
  type Capability,
  type IProviderRegistry,
  type ResolvedProvider,
} from './provider.contract.js'

/**
 * IProviderRegistry:从 ProviderAssignment → Provider 解析指派给某能力的服务商。
 * models 是 JSON:{ main, vision, image, video };apiKeyEnc 信封解密。
 */
@Provide(PROVIDER_REGISTRY)
@Scope(ScopeEnum.Singleton)
export class ProviderService implements IProviderRegistry {
  @Inject(PRISMA) private readonly db!: PrismaService

  async resolve(capability: Capability): Promise<ResolvedProvider | null> {
    const a = await this.db.client.providerAssignment.findUnique({
      where: { capability },
      include: { provider: true },
    })
    if (!a?.provider) return null
    const p = a.provider
    const models = safeJson(p.models) as Record<string, string>
    const model = capability === 'llm' ? (models.main ?? '') : (models[capability] ?? models.main ?? '')
    return { code: p.code, baseURL: p.baseUrl, apiKey: decryptSecret(p.apiKeyEnc), model, apiFormat: p.apiFormat }
  }
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
