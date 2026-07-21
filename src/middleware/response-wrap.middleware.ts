import { Middleware, type IMiddleware } from '@midwayjs/core'
import type { Context, NextFunction } from '@midwayjs/koa'

/**
 * 统一响应信封:/api/* 成功响应包成 { success:true, data }。
 * 前端(cms/客户端)统一按 {success,data} 拆包(见 cms/src/api.ts)。
 */
@Middleware()
export class ResponseWrapMiddleware implements IMiddleware<Context, NextFunction> {
  resolve() {
    return async (ctx: Context, next: NextFunction) => {
      const result = await next()
      if (result !== undefined && result !== null) {
        const r = result as { success?: unknown }
        return r.success !== undefined ? result : { success: true, data: result }
      }
      return result
    }
  }

  match(ctx: Context): boolean {
    // 信封只给 cms 后台(其前端统一拆 {success,data});
    // app/客户端端点(/api/auth、/api/sessions、/api/account…)保持裸响应,客户端直接读。
    return ctx.path.startsWith('/api/cms/')
  }
}
