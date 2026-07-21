import { Configuration, type ILifeCycle, App } from '@midwayjs/core'
import * as koa from '@midwayjs/koa'
import * as ws from '@midwayjs/ws'
import * as validate from '@midwayjs/validate'
import agentConfig from './config/config.default.js'
import { ResponseWrapMiddleware } from './middleware/response-wrap.middleware.js'
import { ApiErrorFilter } from './filter/api-error.filter.js'
import { seedDatabase } from './database/seed.js'

// 让入口模块(configuration)导出所有组件类 → Midway 对入口模块导出逐一 bindClass 绑定到 IoC。
export * from './components.js'

/**
 * @midwayjs/ws 无端口配置 → 自动 attach 到 koa 的 http server(共享 7001,单端口)。
 * /ws/:sessionId 由 AgentWsController(@WSController)处理,不再手搓 upgrade。
 */
@Configuration({
  imports: [koa, ws, validate],
  importConfigs: [{ default: agentConfig }],
})
export class MainConfiguration implements ILifeCycle {
  @App('koa') app!: koa.Application

  async onReady(): Promise<void> {
    this.app.useMiddleware([ResponseWrapMiddleware]) // /api/cms/* → {success,data}
    this.app.useFilter([ApiErrorFilter]) // 错误 → {success:false,message}
    if (this.app.getEnv() !== 'unittest') await seedDatabase()
  }
}
