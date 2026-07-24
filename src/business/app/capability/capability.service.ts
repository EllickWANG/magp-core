import { Inject, Provide, Scope, ScopeEnum } from '@midwayjs/core'
import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import {
  CAPABILITY,
  type GroundingBox,
  type GroundingResult,
  type ICapability,
} from '../../common/agent/tools/tool.contract.js'
import type { TurnMeta } from '../../common/agent/domain/index.js'
import { PROVIDER_REGISTRY, type IProviderRegistry, type ResolvedProvider } from '../provider/provider.contract.js'
import { USAGE_SERVICE, type IUsageService } from '../usage/usage.contract.js'
import { generateVideo as generateVideoProtocol, type GenerateVideoResult } from './protocol/video.js'

/**
 * 业务实现 agent 的 CAPABILITY:看图/生图 —— 解析对应 provider,in-process 调 OpenAI 兼容接口 + 记账。
 */
@Provide(CAPABILITY)
@Scope(ScopeEnum.Singleton)
export class CapabilityService implements ICapability {
  @Inject(PROVIDER_REGISTRY) private readonly providers!: IProviderRegistry
  @Inject(USAGE_SERVICE) private readonly usage!: IUsageService

  private client(p: ResolvedProvider): OpenAI {
    return new OpenAI({ baseURL: p.baseURL, apiKey: p.apiKey })
  }

  async describeImage(input: { url: string; prompt?: string }, meta: TurnMeta, signal: AbortSignal): Promise<unknown> {
    const p = await this.providers.resolve('vision')
    if (!p) throw new Error('未指派 vision 服务商')
    const res = await this.client(p).chat.completions.create(
      {
        model: p.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: input.prompt?.trim() || '简要描述这张图片的内容。' },
              { type: 'image_url', image_url: { url: input.url } },
            ],
          },
        ],
      },
      { signal },
    )
    await this.usage.record({
      userId: meta.userId,
      requestId: randomUUID(),
      provider: p.code,
      model: p.model,
      capability: 'vision',
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      totalTokens: res.usage?.total_tokens ?? 0,
    })
    return { text: res.choices[0]?.message?.content ?? '' }
  }

  /**
   * 视觉定位 —— 用 **vision 服务商**在图里框出目标(不再单设 grounding 槽)。
   *
   * 三条硬约束(不准的根因全在这):**告诉模型确切像素尺寸**、**只准回 JSON bbox**、
   * **把可能的归一化坐标映射回像素**。少任何一条,拿到的都是散文里的约数。
   */
  async locateInImage(
    input: { imageBase64: string; mimeType: string; width: number; height: number; target: string },
    meta: TurnMeta,
    signal: AbortSignal,
  ): Promise<GroundingResult> {
    const p = await this.providers.resolve('vision')
    if (!p) throw new Error('未指派 vision 服务商(视觉定位用的就是它)')
    const { width: W, height: H } = input
    const prompt =
      `你是 GUI 元素定位器。这张截图的尺寸是 ${W}×${H} 像素。\n` +
      `请找出:${input.target}\n\n` +
      `**只输出 JSON,不要任何解释、不要 markdown 代码块**:\n` +
      `找到:{"found":true,"box":{"x":左上角x,"y":左上角y,"w":宽,"h":高},"space":{"w":坐标系宽,"h":坐标系高},"confidence":0到1}\n` +
      `没找到:{"found":false,"note":"原因"}\n\n` +
      `坐标请用**相对这张 ${W}×${H} 图片的像素值**,x+w 不超过 ${W},y+h 不超过 ${H}。\n` +
      `**"space" 必填**:写下你输出的坐标所基于的坐标系宽高 —— 如果你用的是像素就填 ${W} 和 ${H},` +
      `如果你习惯用归一化坐标(例如 0~1000)就如实填 1000 和 1000。我会据此换算,填错会导致点错位置。\n` +
      `框要**紧贴目标元素本身**(比如关闭按钮就只框那个 ×,不要框整个弹窗)。`

    const res = await this.client(p).chat.completions.create(
      {
        model: p.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { url: `data:${input.mimeType};base64,${input.imageBase64}` },
              },
            ],
          },
        ],
      },
      { signal },
    )
    await this.usage.record({
      userId: meta.userId,
      requestId: randomUUID(),
      provider: p.code,
      model: p.model,
      capability: 'vision',
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      totalTokens: res.usage?.total_tokens ?? 0,
    })
    return parseGrounding(res.choices[0]?.message?.content ?? '', W, H)
  }

  async generateImage(input: { prompt: string }, meta: TurnMeta, signal: AbortSignal): Promise<unknown> {
    const p = await this.providers.resolve('image')
    if (!p) throw new Error('未指派 image 服务商')
    const res = await this.client(p).images.generate({ model: p.model, prompt: input.prompt }, { signal })
    await this.usage.record({
      userId: meta.userId,
      requestId: randomUUID(),
      provider: p.code,
      model: p.model,
      capability: 'image',
      totalTokens: 0,
    })
    return { url: res.data?.[0]?.url ?? '', b64: res.data?.[0]?.b64_json ?? null }
  }

  /**
   * 生视频 —— 用指派给「视频」能力的服务商(异步:提交→轮询→下载,协议在 protocol/video)。
   * 上游不回 token 用量 → 记一条 0-token 的调用行(生成次数本身就是账)。只在成功时记账。
   */
  async generateVideo(input: { prompt: string }, meta: TurnMeta, signal: AbortSignal): Promise<GenerateVideoResult> {
    const p = await this.providers.resolve('video')
    if (!p) return { ok: false, error: '未指派视频服务商 —— 去后台把某个服务商指派给「视频」能力。' }
    const r = await generateVideoProtocol(p, input.prompt, signal)
    if (r.ok) {
      await this.usage.record({
        userId: meta.userId,
        requestId: randomUUID(),
        provider: p.code,
        model: p.model,
        capability: 'video',
        totalTokens: 0,
      })
    }
    return r
  }
}

/**
 * 解析定位模型的回复 → 图片像素空间的 bbox。
 *
 * 两个坑必须在这里填平:
 *  1. **模型爱包 markdown / 加解释** → 抠出第一段 JSON,而不是 JSON.parse 整段。
 *  2. **归一化坐标**:很多定位模型输出 0~1000(而非真实像素)。靠数值猜会猜错(897 既可能是像素也可能是
 *     归一化),所以让模型**自报它用的坐标系(space)**,这里按 W/space.w 精确换算 —— 没自报就当像素。
 */
export function parseGrounding(text: string, W: number, H: number): GroundingResult {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { found: false, note: `定位模型没有返回 JSON:${text.slice(0, 120)}` }
  let raw: {
    found?: unknown
    box?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
    space?: { w?: unknown; h?: unknown }
    confidence?: unknown
    note?: unknown
  }
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { found: false, note: `定位模型返回的 JSON 解析失败:${text.slice(0, 120)}` }
  }
  if (raw.found !== true || !raw.box) {
    return { found: false, note: typeof raw.note === 'string' ? raw.note : '定位模型说没找到目标。' }
  }
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
  const bx = n(raw.box.x), by = n(raw.box.y), bw = n(raw.box.w), bh = n(raw.box.h)
  if ([bx, by, bw, bh].some(Number.isNaN)) return { found: false, note: 'bbox 数值不合法。' }

  // 坐标系换算:模型自报 space 就按它换算(0~1000 之类),没报就当像素。
  const sw = n(raw.space?.w) > 0 ? n(raw.space!.w) : W
  const sh = n(raw.space?.h) > 0 ? n(raw.space!.h) : H
  const kx = W / sw, ky = H / sh
  const clamp = (v: number, hi: number): number => Math.min(hi, Math.max(0, v))
  const box: GroundingBox = {
    x: clamp(bx * kx, W),
    y: clamp(by * ky, H),
    w: clamp(bw * kx, W),
    h: clamp(bh * ky, H),
  }
  if (box.w < 1 || box.h < 1) return { found: false, note: 'bbox 尺寸为 0,视作没定位到。' }
  const conf = n(raw.confidence)
  return { found: true, box, confidence: Number.isNaN(conf) ? undefined : conf }
}
