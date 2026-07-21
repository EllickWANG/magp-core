/** usage 域:记账 + 配额。 */
export const USAGE_SERVICE = 'app:usage-service'

export interface RecordUsageInput {
  userId: string
  requestId: string // 幂等键
  provider: string
  model: string
  capability: 'llm' | 'vision' | 'image' | 'video'
  inputTokens?: number
  outputTokens?: number
  totalTokens: number
}

export interface IUsageService {
  /** 记一次用量(requestId 幂等,重复静默跳过);同时扣当前周期配额。 */
  record(input: RecordUsageInput): Promise<void>
}
