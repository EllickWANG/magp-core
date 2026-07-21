import { Body, Controller, httpError, Inject, Post } from '@midwayjs/core'
import { Context } from '@midwayjs/koa'
import { AUTH_SERVICE, type IAuthService } from '../auth/auth.contract.js'
import * as gesture from './gesture.algo.js'

type Point = { x: number; y: number }

function point(value: unknown): Point | null {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as Point).x === 'number' &&
    typeof (value as Point).y === 'number'
  ) {
    return { x: (value as Point).x, y: (value as Point).y }
  }
  return null
}

/**
 * 手势规划端点 —— 客户端 inputEngine 每次移动/点击/拖拽/键入前来这里拿算好的贝塞尔轨迹再 replay。
 * 算法只在服务端(gesture.algo),客户端设备上没有它。
 */
@Controller('/api/gesture')
export class GestureController {
  @Inject() ctx!: Context
  @Inject(AUTH_SERVICE) private readonly auth!: IAuthService

  @Post('/plan')
  async plan(@Body() body: Record<string, unknown>): Promise<unknown> {
    this.requireUser()
    const b = body ?? {}
    const rawView = b.view as { w?: unknown; h?: unknown } | undefined
    const view = { w: Number(rawView?.w) || 0, h: Number(rawView?.h) || 0 }
    const from = point(b.from)

    switch (b.kind) {
      case 'move': {
        const to = point(b.to)
        if (!to) throw new httpError.BadRequestError('move 需要 to')
        return gesture.planMove(from, to, view)
      }
      case 'click': {
        const to = point(b.to)
        if (!to) throw new httpError.BadRequestError('click 需要 to')
        return gesture.planClick(from, to, view)
      }
      case 'drag': {
        const start = point(b.start)
        const end = point(b.end)
        if (!start || !end) throw new httpError.BadRequestError('drag 需要 start 和 end')
        return gesture.planDrag(from, start, end, view)
      }
      case 'type':
        return gesture.planType(typeof b.text === 'string' ? b.text : '')
      default:
        throw new httpError.BadRequestError(`未知 kind: ${String(b.kind)}`)
    }
  }

  private requireUser(): { userId: string } {
    const h = this.ctx.get('authorization') || ''
    const v = this.auth.verifyAccess(h.startsWith('Bearer ') ? h.slice(7) : '')
    if (!v) throw new httpError.UnauthorizedError()
    return v
  }
}
