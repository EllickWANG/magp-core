import { Body, Controller, Get, Inject, Post } from '@midwayjs/core'
import { Context } from '@midwayjs/koa'
import { AUTH_SERVICE, type IAuthService } from '../auth/auth.contract.js'
import { CLIENT_CHANNEL, type IClientChannel } from '../../common/agent/session/channel.contract.js'
import { SESSION_SERVICE, type ISessionService } from './session.contract.js'
import { WsHub } from './ws-hub.js'

/**
 * 浏览器控制端点 —— 让**外部 agent**(magp-browser skill)驱动某台 Magp 客户端里的真实浏览器。
 *
 * 拓扑:客户端拨出去连 core 的 /ws/:sessionId(没有入站端口);core 是**中枢**——外部 agent
 * 经这里把一条浏览器指令中继给对应会话的客户端,客户端**照常过它自己的全部安全闸**
 * (工具风险分级 / 审批 / beforeAction 风控节流),回执再原路返回。core 不放松任何东西:
 *   - 鉴权:Bearer(外部 agent 以用户身份登录);
 *   - 归属:只能驱动**自己拥有**的会话(isOwner);
 *   - 面收窄:只中继**浏览器/只读**工具白名单,不当"任意客户端工具"的通道;
 *   - 安全闸不在这实现,也不在这绕过 —— 它们在客户端一侧,中继的指令照样触发。
 */

/** 允许经此端点中继的工具白名单(= magp-browser skill 的命令面)。别的工具一律拒。 */
const ALLOWED_TOOLS = new Set<string>([
  'browser_open_home',
  'browser_navigate',
  'browser_snapshot',
  'browser_read',
  'browser_next_page',
  'browser_click',
  'browser_fill',
  'browser_press_key',
  'browser_scroll',
  'browser_click_visual',
  'workbench_screenshot',
])

const RELAY_TIMEOUT_MS = 130_000 // 略高于 channel 自身 120s,让更清晰的 "client tool timeout" 先触发

@Controller('/api/browser')
export class BrowserControlController {
  @Inject() ctx!: Context
  @Inject() private readonly hub!: WsHub
  @Inject(AUTH_SERVICE) private readonly auth!: IAuthService
  @Inject(SESSION_SERVICE) private readonly sessions!: ISessionService
  @Inject(CLIENT_CHANNEL) private readonly channel!: IClientChannel

  /** 我的、当前**有客户端连着**的会话 —— 外部 agent 据此挑一个可驱动的目标。 */
  @Get('/targets')
  async targets(): Promise<unknown> {
    const userId = this.userId()
    if (!userId) return this.reply(401, { ok: false, error: '未登录' })
    const mine = await this.sessions.listByUser(userId)
    const live = mine
      .filter((s) => this.hub.hasClients(s.sessionId))
      .map((s) => ({ sessionId: s.sessionId, title: s.title, status: s.status }))
    return this.reply(200, { ok: true, targets: live })
  }

  /**
   * 把一条浏览器指令中继给指定会话的客户端并等回执。
   * body: { sessionId, tool, input }
   */
  @Post('/exec')
  async exec(@Body() body: Record<string, unknown>): Promise<unknown> {
    const userId = this.userId()
    if (!userId) return this.reply(401, { ok: false, error: '未登录' })

    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    const tool = typeof body?.tool === 'string' ? body.tool : ''
    const input = (body?.input ?? {}) as Record<string, unknown>

    if (!sessionId || !tool) return this.reply(400, { ok: false, error: '缺少 sessionId 或 tool' })
    if (!ALLOWED_TOOLS.has(tool)) {
      return this.reply(400, { ok: false, error: `工具 ${tool} 不在浏览器控制白名单内` })
    }
    // 归属门禁:只能驱动自己的会话。
    if (!(await this.sessions.isOwner(userId, sessionId))) {
      return this.reply(404, { ok: false, error: '会话不存在或不属于你' })
    }
    // 该会话得真有客户端连着,否则指令没人执行,只会白等到超时。
    if (!this.hub.hasClients(sessionId)) {
      return this.reply(409, { ok: false, error: '该会话当前没有客户端连接(先在 Magp 客户端打开对应工作台)' })
    }

    try {
      const result = await this.channel.request(sessionId, { tool, input }, AbortSignal.timeout(RELAY_TIMEOUT_MS))
      return this.reply(200, { ok: true, result })
    } catch (e) {
      // 客户端把工具的引导性错误文案作为 reject 回来(如"没有浏览器身份,请去建")——原样带给调用方。
      return this.reply(502, { ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  private userId(): string | null {
    const h = this.ctx.get('authorization') || ''
    return this.auth.verifyAccess(h.startsWith('Bearer ') ? h.slice(7) : '')?.userId ?? null
  }

  private reply(status: number, payload: unknown): unknown {
    this.ctx.status = status
    return payload
  }
}
