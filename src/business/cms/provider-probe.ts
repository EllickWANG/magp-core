import OpenAI from 'openai'
import { protocolFor, openaiBaseURL, normalizeFormat } from '../common/agent/model/protocols/index.js'

/**
 * 服务商探活 —— **拿真实请求打一次上游**。改完配置一定点它。
 *
 * 两段分开报,因为坏起来的样子完全不同:
 *  - **连通**:够不够得着 baseUrl、密钥认不认。坏在这里 = URL 写错 / key 失效 / 网络不通。
 *  - **模型往返**:**按这个服务商自己配的协议**(claude 原生 / OpenAI Chat / Responses / deepseek)
 *    真调一次它将来会被调的那个接口。协议或模型名配错就死在这一步 —— 连通可能还是绿的,
 *    agent 却一路失败,界面上只表现为「不回话」。不试的话,你只能对着日志猜半天。
 *
 * ## 为什么必须"按能力探对应的接口"
 *
 * 图片服务商拿生图模型去打**对话接口**,上游只会回一句 "model not found" ——
 * 看着像模型名写错了,其实模型好好的,是探活敲错了门。你会照着这句去改模型名,越改越错。
 */
export type ProbeStep = { ok: boolean; latencyMs: number; error?: string }
export type ProbeReport = { ok: boolean; connectivity: ProbeStep; roundtrip?: ProbeStep }

const now = (): number => Date.now()

/** 把上游/网络异常翻成一句**能照着动手**的话,而不是抛一坨 stack。 */
function explain(e: unknown): string {
  const err = e as { status?: number; message?: string; code?: string; cause?: { code?: string } }
  const status = err?.status
  const code = err?.code ?? err?.cause?.code
  if (status === 401 || status === 403) return `密钥被拒(${status})—— 检查 API Key 是否正确/已过期`
  if (status === 404) return '接口 404 —— baseUrl 路径或模型名不对(常见:少了/多了 /v1)'
  if (status === 429) return '被限流(429)—— 上游额度或频率到顶了'
  if (status && status >= 500) return `上游 ${status} —— 服务商侧故障,稍后再试`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析不了 —— baseUrl 的域名写错了?'
  if (code === 'ECONNREFUSED') return '连接被拒 —— 地址/端口不对,或对方没在监听'
  if (code === 'ETIMEDOUT' || err?.message?.includes('timed out') || err?.message?.includes('aborted')) {
    return '超时 —— 网络不通或上游太慢'
  }
  return err?.message ? String(err.message).slice(0, 220) : String(e).slice(0, 220)
}

/** 带超时的信号 —— 探活要的是一次明确结论,不能无限等。 */
function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

/**
 * 第一段:连通 + 认证。用各协议的模型列表端点探,最轻、不计费。
 * Anthropic 用 x-api-key,OpenAI 系用 Bearer —— 头都不一样,不能一套打天下。
 */
async function probeConnectivity(baseURL: string, apiKey: string, apiFormat: string): Promise<ProbeStep> {
  const t0 = now()
  try {
    if (normalizeFormat(apiFormat) === 'anthropic') {
      const res = await fetch(`${openaiBaseURL(baseURL)}/models`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: timeoutSignal(12_000),
      })
      if (res.status === 404) {
        return { ok: true, latencyMs: now() - t0, error: '网关未开放 /models(不影响使用),以模型往返为准' }
      }
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status}`) as Error & { status?: number }
        e.status = res.status
        throw e
      }
      return { ok: true, latencyMs: now() - t0 }
    }
    await new OpenAI({ baseURL: openaiBaseURL(baseURL), apiKey, timeout: 12_000, maxRetries: 0 }).models.list()
    return { ok: true, latencyMs: now() - t0 }
  } catch (e) {
    // 不少中转网关不开放 /models。**这不算坏** —— 别让一个可选接口把好服务商判成红的。
    if ((e as { status?: number })?.status === 404) {
      return { ok: true, latencyMs: now() - t0, error: '网关未开放 /models(不影响使用),以模型往返为准' }
    }
    return { ok: false, latencyMs: now() - t0, error: explain(e) }
  }
}

/** 第二段:按能力 + 按协议,真调一次它将来会被调的那个接口。 */
async function probeRoundtrip(input: {
  baseURL: string
  apiKey: string
  apiFormat: string
  capabilities: string[]
  models: Record<string, string>
}): Promise<ProbeStep> {
  const { baseURL, apiKey, apiFormat, capabilities, models } = input
  const has = (c: string): boolean => capabilities.includes(c)
  const t0 = now()

  // 只会生图的服务商 → 探生图接口(拿生图模型打对话接口只会得到误导性的 "model not found")。
  if (has('image') && !has('llm')) {
    const model = models.image?.trim() || models.main?.trim()
    if (!model) return { ok: false, latencyMs: 0, error: '没填图片模型(也没有主模型可回落)' }
    try {
      await new OpenAI({ baseURL: openaiBaseURL(baseURL), apiKey, timeout: 90_000, maxRetries: 0 }).images.generate({
        model,
        prompt: 'a small red dot on white',
        n: 1,
      })
      return { ok: true, latencyMs: now() - t0 }
    } catch (e) {
      return { ok: false, latencyMs: now() - t0, error: explain(e) }
    }
  }

  // 只会生视频的:一次生成要跑几分钟,探活等不起 —— 如实说明,而不是假装绿灯。
  if (has('video') && !has('llm') && !has('image')) {
    return { ok: false, latencyMs: 0, error: '视频服务商暂不支持探活(一次生成数分钟);请用生成任务实测' }
  }

  // 其余(llm / vision / grounding)走对话接口,**用它自己配的协议**。
  const model = models.main?.trim()
  if (!model) return { ok: false, latencyMs: 0, error: '没填主模型' }
  try {
    await protocolFor(apiFormat).ping({ baseURL, apiKey, model, apiFormat }, timeoutSignal(30_000))
    return { ok: true, latencyMs: now() - t0 }
  } catch (e) {
    return { ok: false, latencyMs: now() - t0, error: explain(e) }
  }
}

export async function probeProvider(input: {
  baseURL: string
  apiKey: string
  apiFormat: string
  capabilities: string[]
  models: Record<string, string>
}): Promise<ProbeReport> {
  const connectivity = await probeConnectivity(input.baseURL, input.apiKey, input.apiFormat)
  // 连不上就别再打第二枪:那只会再等一个超时,还会把同一个原因报两遍。
  if (!connectivity.ok) return { ok: false, connectivity }
  const roundtrip = await probeRoundtrip(input)
  return { ok: connectivity.ok && roundtrip.ok, connectivity, roundtrip }
}
