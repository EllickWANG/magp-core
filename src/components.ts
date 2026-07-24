/**
 * 组件清单 —— re-export 所有 @Provide/@Controller 组件类。
 * 作为 namespace 放进 @Configuration.imports,Midway 对其导出逐一 bindClass 绑定到 IoC 容器。
 * (本项目按 import 图注册,非全目录扫描;按 token @Provide 的实现类不这样登记就进不了容器。)
 * 新增组件记得在此 re-export。
 */

// 基础设施
export { PrismaService } from './database/prisma.service.js'

// agent 内核实现(按 token 绑定)
export { AgentEngine } from './business/common/agent/engine/agent.engine.js'
export { MultiProtocolModelProvider } from './business/common/agent/model/multi-protocol.provider.js'
export { AgentToolRegistry } from './business/common/agent/tools/tool-registry.js'
export { StreamJsonCodec } from './business/common/agent/protocol/stream-json.codec.js'
export { PrismaTranscriptStore } from './business/common/agent/persistence/prisma-transcript.store.js'
export { AgentSessionManager } from './business/common/agent/session/session.manager.js'

// 业务·app 域
export { ProviderService } from './business/app/provider/provider.service.js'
export { ModelConfigProvider } from './business/app/provider/model-config.provider.js'
export { CapabilityService } from './business/app/capability/capability.service.js'
export { CapabilityController } from './business/app/capability/capability.controller.js'
export { ToolPolicyPermission } from './business/app/toolpolicy/permission.provider.js'
export { UsageService } from './business/app/usage/usage.service.js'
export { AuthService } from './business/app/auth/auth.service.js'
export { AuthController } from './business/app/auth/auth.controller.js'
export { RegistrationGate } from './business/app/registration/registration.service.js'
export { AccountController } from './business/app/account/account.controller.js'
export { GestureController } from './business/app/gesture/gesture.controller.js'
export { GuardController } from './business/app/guard/guard.controller.js'
export { WsHub } from './business/app/session/ws-hub.js'
export { WsClientChannel } from './business/app/session/ws-channel.provider.js'
export { AgentWsController } from './business/app/session/ws.controller.js'
export { SessionService } from './business/app/session/session.service.js'
export { SessionController } from './business/app/session/session.controller.js'
export { BrowserControlController } from './business/app/session/browser-control.controller.js'

// 业务·cms 域
export { CmsController } from './business/cms/cms.controller.js'
export { CmsAuthController } from './business/cms/cms-auth.controller.js'
export { CmsSecurityController } from './business/cms/cms-security.controller.js'
export { AuditService } from './business/cms/audit.service.js'

// 中间件 / 过滤器
export { ResponseWrapMiddleware } from './middleware/response-wrap.middleware.js'
export { ApiErrorFilter } from './filter/api-error.filter.js'
