import type { MidwayConfig } from '@midwayjs/core'

export default {
  keys: process.env.COOKIE_KEYS ?? 'magp-core-dev',
  koa: { port: Number(process.env.PORT ?? 7001) },

  // 模型 provider 走 CMS 配置(provider 域),不在 env。这里只放引擎运行参数。
  agent: {
    system: process.env.AGENT_SYSTEM_PROMPT ?? '你是 Magp 的编排 agent:给客户端下指令、生成简报。',
    maxSteps: Number(process.env.AGENT_MAX_STEPS ?? 20),
  },
} as MidwayConfig & {
  agent: { system: string; maxSteps: number }
}
