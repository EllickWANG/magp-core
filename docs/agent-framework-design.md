# Magp Agent 框架设计(自研 · Midway 原生 · 单进程)

> 状态:设计 v1(与 `core/` 代码一致,commit 41b3e77 起)
> 定位:在 **一个 Midway v4 进程**内自研 agent 执行层,替换旧 Bun `agent-runtime`(vendored Claude Code)。
> agent = **编排器**:给客户端下指令(浏览器)、生成简报、调内部能力(看图/生图);
> **不在服务端执行代码**(无 Bash/文件沙箱)。model-agnostic(deepseek 等 OpenAI 兼容),保留 MCP。

本文档定架构与契约。实现前以此为准;实现后此文档与代码保持一致。

---

## 0. 原则

1. **单进程、单 package**:一个 Midway app,`import` 即调用,零网络/零内部 secret 边界(旧的两进程边界已废弃)。
2. **两层边界**(见 §1):外层业务/agent 用**文件夹**分;内层 agent 的可换点用 **Midway 模块 + 接口 token + DI** 分。
3. **引擎只认接口**:agent 引擎只 `@Inject` 接口 token,不认实现;换实现不动引擎。
4. **纯逻辑可脱框架测**:turn/session 循环是纯函数,不依赖 Midway,能在无容器/无网络/无 DB 下单测。
5. **跨边界只传纯数据**:`AgentEvent` / `Message` 等不可变值;活对象(ws 句柄、DB、SDK 对象)不进引擎与领域层。
6. **协议隔离**:客户端 stream-json 只存在于 `protocol/` 一个实现里,带版本;引擎不认 wire 形状。
7. **错误是值**:工具失败 = `tool_result(isError)` 继续;引擎不让进程崩。

---

## 1. 两层边界(核心)

```
外层(业务 vs agent):靠【文件夹】
  business/app  business/cms   ── 业务域
  business/common/agent        ── agent(被业务复用的公共能力)
  规则:agent 不许依赖 business/app|cms(CI 强制)

内层(agent 的四个可换点):靠【Midway 模块 + 接口 token + DI】
  engine ──@Inject(token)──▶ IModelProvider / IToolRegistry / IClientProtocol / ITranscriptStore ...
  规则:engine 只 import 各模块的 *.contract,不许 import 实现文件(CI 强制)
```

- **边界单位 = Midway 模块(文件夹)**。每个模块只对外给一个 `*.contract.ts`(接口 + 注入 token),实现私有。
- **解耦机制 = 接口 token + DI**。TS 接口运行时会被擦除,所以用 **string token** 绑:
  `@Provide(TOKEN)` 注册实现,`@Inject(TOKEN)` 拿接口。换实现 = 换绑到 token 的类。

---

## 2. 目录结构(实际)

```
core/src/
  business/
    app/                          # 业务·app 端(auth/session/capability/usage… 迁移搬入)
    cms/                          # 业务·cms 端(rbac/auth… 迁移搬入)
    common/
      session-events.ts           # 通用转录存储(PG session_events;业务与 agent 共用)
      agent/
        domain/index.ts           # 纯类型:Message / AgentEvent / ToolCall + 构造器
        engine/
          agent.contract.ts       # RunCtx / AgentRunSpec / SessionInput / IAgentEngine + AGENT_ENGINE
          turn.ts  session.ts     # 纯循环逻辑(可脱 Midway 单测)
          agent.engine.ts         # @Provide(AGENT_ENGINE):@Inject 各接口,委派纯逻辑
          turn.test.ts            # 引擎单测(fakes,无 Midway/DB/网络)
        model/                    # 解耦① 模型/provider
          model.contract.ts       #   IModelProvider + MODEL_PROVIDER + ModelDelta/ToolSpec
          openai-compatible.provider.ts  # @Provide(MODEL_PROVIDER)
        tools/                    # 解耦② 工具/能力
          tool.contract.ts        #   ITool/IToolRegistry/ICapability + TOOL_REGISTRY/CAPABILITY
          tool-registry.ts        #   @Provide(TOOL_REGISTRY)
          browser.tool.ts         #   普通 ITool 对象(下指令给客户端)
          capability.provider.ts  #   @Provide(CAPABILITY)
        protocol/                 # 解耦③ 客户端协议
          protocol.contract.ts    #   IClientProtocol + CLIENT_PROTOCOL + WireFrame
          stream-json.codec.ts    #   @Provide(CLIENT_PROTOCOL)
        persistence/              # 解耦④ 持久化/会话
          transcript.contract.ts  #   ITranscriptStore + TRANSCRIPT_STORE
          pg-transcript.store.ts  #   @Provide(TRANSCRIPT_STORE)(内脏 = session-events)
        permission/               # 工具权限门
          permission.contract.ts  #   IPermission + PERMISSION
          allow-all.permission.ts #   @Provide(PERMISSION)(默认放行,TODO 接 toolpolicy)
        session/                  # 会话生命周期 + WS 通道
          channel.contract.ts     #   IClientChannel + CLIENT_CHANNEL
          ws.channel.ts           #   @Provide(CLIENT_CHANNEL)
          session.manager.ts      #   @Singleton 组合根:装配引擎+协议+转录+通道,驱动会话
  config/config.default.ts  configuration.ts  bootstrap.js
```

---

## 3. 领域模型(`domain/`,不可变值)

```ts
type Role = 'user' | 'assistant' | 'tool'
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; result: unknown; isError: boolean }
interface Message { role: Role; content: readonly ContentPart[] }
interface ToolCall { id: string; name: string; input: unknown }
interface TurnMeta { sessionId: string; userId: string }

// 引擎对外唯一货币
type AgentEvent =
  | { t:'turn_start'; turnId } | { t:'assistant_delta'; turnId; delta }
  | { t:'assistant_message'; turnId; message } | { t:'tool_use'; turnId; call }
  | { t:'tool_progress'; turnId; callId; msg } | { t:'tool_result'; turnId; callId; result; isError }
  | { t:'turn_end'; turnId; reason:'stop'|'max_steps'|'aborted'|'error' }
  | { t:'error'; turnId; code; message }
```

约束:领域层无活对象(无 WebSocket/Promise/DB/SDK)。

---

## 4. 四个解耦点 + token 一览

| 解耦点 | 模块 | 接口 | token | 默认实现 |
|---|---|---|---|---|
| ① 模型/provider | `model/` | `IModelProvider` | `MODEL_PROVIDER` | OpenAI 兼容(deepseek…),真实流式 |
| ② 工具/能力 | `tools/` | `IToolRegistry` / `ICapability` | `TOOL_REGISTRY` / `CAPABILITY` | 注册表 + browser 工具 + 能力占位 |
| ③ 客户端协议 | `protocol/` | `IClientProtocol` | `CLIENT_PROTOCOL` | stream-json codec |
| ④ 持久化/会话 | `persistence/` | `ITranscriptStore` | `TRANSCRIPT_STORE` | 接 `session-events`(PG) |
| 工具权限门 | `permission/` | `IPermission` | `PERMISSION` | 放行(TODO toolpolicy) |
| 客户端通道 | `session/` | `IClientChannel` | `CLIENT_CHANNEL` | WS(TODO 接 hub) |

换任意一项 = 写一个新 `@Provide(TOKEN)` 实现类替换,引擎与其他模块一行不动。

---

## 5. 契约(接口定义)

```ts
// model.contract.ts
interface IModelProvider { stream(req:{system,messages,tools,signal}): AsyncIterable<ModelDelta> }
type ModelDelta = {type:'text';delta} | {type:'tool_call';call:ToolCall} | {type:'stop';reason}

// tool.contract.ts
interface ITool<I> { name; description; inputSchema:ZodType<I>; isEnabled(meta); execute(input,ctx):AsyncIterable<ToolYield> }
interface IToolRegistry { get(name); enabled(meta); enabledSpecs(meta) }   // spec = zod→JSON Schema
interface ICapability { describeImage(...); generateImage(...) }
// ToolCtx 只给工具注入:meta / capability / dispatchToClient / signal —— 工具不认识 ws/db

// protocol.contract.ts
interface IClientProtocol { version; encode(e):WireFrame|null; decodeClientMessage(w):DecodedInput; toTranscriptLine(e):string }

// persistence / permission / channel
interface ITranscriptStore { append(sessionId,events,signal); load(sessionId,signal):Message[] }
interface IPermission { check({tool,args,meta,signal}): {allow:true}|{allow:false;reason} }
interface IClientChannel { dispatch(sessionId,frame,signal): Promise<unknown> }
```

---

## 6. 引擎规格(`engine/turn.ts` · `session.ts`,纯函数)

`runTurn(ctx: RunCtx)` 把 `(messages, tools, model, permission)` 变成 `AgentEvent` 流。
**只 yield**,不写盘、不发 ws —— 持久化与下发由 `AgentSessionManager` 消费事件时做(单流多消费)。

turn 状态机:

```
turn_start
loop step<maxSteps:
  model.stream → 边收边 yield assistant_delta;收敛 (text, toolCalls)
  messages.push(assistant); yield assistant_message
  toolCalls 空 → yield turn_end(stop); return
  for each call: 权限门→校验入参→execute(逐 progress)→messages.push(tool_result); yield tool_use/…/tool_result
  signal.aborted → yield turn_end(aborted); return
yield turn_end(max_steps)
```

**不变式(评审 checklist)**:取消随时生效(每 await 前后查 `signal.aborted`);每个 `tool_use` 必配对
`tool_result`;工具抛错→`tool_result(isError)`,模型流出错→`error`+`turn_end(error)`;引擎不写盘/不发 ws/不崩进程。

`runSession(base, input)`:从 steering 输入队列取用户消息 → 跑一轮 → 重复,直到结束或取消。
`AgentEngine`(`@Provide(AGENT_ENGINE)`)从 DI 注入四件套,组出 `RunCtx`,委派纯 `runSession`。

---

## 7. 组合根与生命周期(`AgentSessionManager`,`@Singleton`)

```
WS 终结(session-socket, 验票→userId)
  └─ onClientMessage(sessionId,userId,wire)
        codec.decodeClientMessage → 进 InputQueue(steering)
        engine.runSession(spec, queue) ── 逐 AgentEvent:
              ① codec.encode → channel.dispatch(广播回客户端)
              ② transcript.append(PG,复用 session-events)
  客户端"停止" → interrupt(sessionId) → AbortController.abort()
```

断线宽限 / 并发上限 / 卸载策略在此,**不进引擎**。会话状态:`idle→running→(aborting)→idle`,全客户端断开过宽限→卸载。

---

## 8. 横切(no-compromise)

- **取消**:一 AbortController/session;`signal` 透传进 model/permission/tool/capability/channel 每次调用。
- **并发**:一 session 串行一个 turn;manager 限全局活跃数 + 每用户并发(复用现有门禁)。turn 内工具默认串行。
- **背压**:事件消费(ws 发送 + PG append)await;`yield` 天然被消费方节流。append 可去抖 1s + 轮末兜底(在 store 内)。
- **错误分层**:工具错→`tool_result(isError)`;模型错→在 provider 内有限重试(退避+signal),耗尽→`error`+`turn_end(error)`;进程级 manager 兜底。
- **幂等/重放**:`(sessionId,seq)` 幂等;重连从 `transcript.load` 复原 messages。
- **超时**:model.stream / tool.execute 各独立超时(`AbortSignal.timeout` 组合)。
- **可观测**:事件即 trace;不埋厂商遥测(Claude Code 的包袱)。

---

## 9. 边界强制(`.dependency-cruiser.cjs`,CI)

1. `business/common/agent` **不许** import `business/app|cms`(agent 是公共能力)。
2. `engine/` **不许** import 兄弟模块的实现文件,只许 import `*.contract`(engine 只认接口)。
3. 禁止循环依赖。

`pnpm lint:boundaries` 绿是合并前置条件。

---

## 10. 测试策略

- **引擎**:用 fakes 实现各接口(FakeModel/FakeChannel/内存 registry),**无 Midway/DB/网络**跑完整 turn/session,断言事件序列(见 `engine/turn.test.ts`,4/4)。
- **实现**:每个契约一套契约测试(真假实现都过)。model provider 用 mock server 验 SSE/tool_call 解析。
- **协议**:`IClientProtocol` 用**现有客户端帧样本**做黄金测试,锁死"不改客户端"。
- **边界**:CI 跑 `lint:boundaries`。

---

## 11. 扩展点(开闭)

加工具=写 `ITool` 塞进 registry;换模型厂商=换 `MODEL_PROVIDER` 实现;换传输=换 `CLIENT_CHANNEL`;
换持久化=换 `TRANSCRIPT_STORE`;改协议=改 `protocol/` 一处 + 升 version。**以上均不动引擎与领域层。**

---

## 12. 非目标

服务端代码执行/Bash/文件沙箱;子 agent/swarm/workflow;插件市场;交互式 TUI;
`feature()` 编译期门控;多进程与内部 secret 边界;厂商遥测。

---

## 13. 迁移

1. 引擎 + 契约 + 默认实现(已落地,单测/typecheck/边界绿)。
2. **ProtocolCodec 帧清单**:盘现有客户端 stream-json 帧,写黄金契约测试(不改客户端的前提)。
3. 接实现:persistence→PG(`session-events`)、permission→toolpolicy、capability→能力服务、channel→WS hub、provider→CMS 投影。
4. 把旧 control-plane 的 `app/cms` 业务搬进 `business/`;接管 `/ws/:sessionId`、`/api/sessions*`。
5. 删旧 `server/apps/agent-runtime` 与两进程内部边界;两镜像并一镜像。

---

## 14. 契约锚点(评审稳定性)

| 契约 | 拥有者 | 稳定性 |
|---|---|---|
| `AgentEvent` / `Message` / `ToolCall` | `domain/` | 高 |
| 各 `I*` 接口 + token | 对应模块 `*.contract` | 中(加方法需评审) |
| `ITool` | `tools/` | 高 |
| wire(stream-json) | `protocol/` | 由客户端决定,版本化 |

> 一句话:**边界在文件夹与接口上,不在进程、也不在包上;引擎只认接口,脏活在实现,协议锁在 codec。**
