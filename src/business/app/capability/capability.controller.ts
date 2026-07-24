import { Body, Controller, Inject, Post } from '@midwayjs/core'
import { Context } from '@midwayjs/koa'
import { AUTH_SERVICE, type IAuthService } from '../auth/auth.contract.js'
import { CAPABILITY, type ICapability } from '../../common/agent/tools/tool.contract.js'

/**
 * 能力 REST 端点 —— 客户端**制图画布**的「生成图片 / 生成视频」按钮直连的地方。
 *
 * 画布走的是直连 HTTP(imageGen.ts / videoGen.ts),不经 agent 工具循环 —— agent 那条路
 * 走 ICapability 的同名方法。两条路复用同一套服务商解析 + 记账(CapabilityService)。
 *
 * ⚠️ 响应形状是**对客户端的既有契约**:`{ ok, image?/video?, error? }`。不套 cms 的
 * `{success,data}` 信封(response-wrap 中间件只匹配 /api/cms/,这里天然是裸响应)。
 */
@Controller('/api')
export class CapabilityController {
  @Inject() ctx!: Context
  @Inject(AUTH_SERVICE) private readonly auth!: IAuthService
  @Inject(CAPABILITY) private readonly capability!: ICapability

  @Post('/image/generate')
  async generateImage(@Body() body: Record<string, unknown>): Promise<unknown> {
    const userId = this.userId()
    if (!userId) return this.reply(401, { ok: false, error: '未登录:接口仅对已登录用户开放。' })
    const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
    if (!prompt.trim()) return this.reply(400, { ok: false, error: 'prompt 不能为空' })
    const size = typeof body?.size === 'string' ? body.size : undefined

    try {
      // 画布生图没有会话,但有登录态 —— 直接记到该用户头上(记账在 CapabilityService 内建)。
      const out = (await this.capability.generateImage(
        { prompt, ...(size ? { size } : {}) } as { prompt: string },
        { sessionId: 'canvas', userId },
        AbortSignal.timeout(120_000),
      )) as { url?: string; b64?: string | null }

      // 服务商可能回 b64,也可能只回 url(DALL·E 系默认给 url)—— 画布要的是字节,url 就现下回来转 b64。
      if (out.b64) return this.reply(200, { ok: true, image: { b64: out.b64, mimeType: 'image/png' } })
      if (out.url) {
        const dl = await downloadBase64(out.url)
        if (dl) return this.reply(200, { ok: true, image: { b64: dl.b64, mimeType: dl.mimeType } })
      }
      return this.reply(502, { ok: false, error: '图片服务商没有返回可用的图像数据。' })
    } catch (e) {
      return this.reply(502, { ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  @Post('/video/generate')
  async generateVideo(@Body() body: Record<string, unknown>): Promise<unknown> {
    const userId = this.userId()
    if (!userId) return this.reply(401, { ok: false, error: '未登录:接口仅对已登录用户开放。' })
    const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
    if (!prompt.trim()) return this.reply(400, { ok: false, error: 'prompt 不能为空' })

    try {
      // 视频协议自己有 4 分钟内部预算;这里再套一层略高于它的硬超时兜底(比客户端 5 分钟早)。
      const gen = await this.capability.generateVideo(
        { prompt },
        { sessionId: 'canvas', userId },
        AbortSignal.timeout(250_000),
      )
      if (!gen.ok) return this.reply(502, { ok: false, error: gen.error })
      return this.reply(200, { ok: true, video: { b64: gen.b64, mimeType: gen.mimeType } })
    } catch (e) {
      return this.reply(502, { ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  /** 从 Bearer 取登录用户;无效返回 null(端点自己回 401 的客户端契约形状,不抛)。 */
  private userId(): string | null {
    const h = this.ctx.get('authorization') || ''
    return this.auth.verifyAccess(h.startsWith('Bearer ') ? h.slice(7) : '')?.userId ?? null
  }

  private reply(status: number, payload: unknown): unknown {
    this.ctx.status = status
    return payload
  }
}

/** 把远程图片 URL 下载成 base64 + mime(画布落盘要字节)。失败返回 null。 */
async function downloadBase64(url: string): Promise<{ b64: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/png'
    return { b64: buf.toString('base64'), mimeType: mimeType.startsWith('image/') ? mimeType : 'image/png' }
  } catch {
    return null
  }
}
