import { Catch } from '@midwayjs/core'
import type { Context } from '@midwayjs/koa'

/** 统一错误信封:{ success:false, message }。httpError 保留其状态码。 */
@Catch()
export class ApiErrorFilter {
  async catch(err: Error & { status?: number }, ctx: Context) {
    const status = err.status ?? 500
    ctx.status = status
    return { success: false, message: err.message || '服务器错误', error: err.name }
  }
}
