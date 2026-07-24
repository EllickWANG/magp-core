import {
  assistantMessage,
  toolResultMessage,
  type AgentEvent,
  type ToolCall,
} from '../domain/index.js'
import type { ToolCtx, ToolYield } from '../tools/tool.contract.js'
import type { RunCtx } from './agent.contract.js'

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e)

/**
 * 一轮 turn:把 (messages, tools, model, permission) 变成 AgentEvent 流。纯函数,只 yield。
 * 不变式:取消随时生效;每个 tool_use 必配对 tool_result;错误变事件不崩进程。
 */
export async function* runTurn(ctx: RunCtx): AsyncGenerator<AgentEvent> {
  const turnId = ctx.newId()
  yield { t: 'turn_start', turnId }

  for (let step = 0; step < ctx.maxSteps; step++) {
    if (ctx.signal.aborted) {
      yield { t: 'turn_end', turnId, reason: 'aborted' }
      return
    }

    const specs = ctx.tools.enabledSpecs(ctx.meta)
    let text = ''
    let thinking = ''
    const calls: ToolCall[] = []

    try {
      for await (const d of ctx.model.stream({
        meta: ctx.meta,
        system: ctx.system,
        messages: ctx.messages,
        tools: specs,
        signal: ctx.signal,
      })) {
        if (d.type === 'text') {
          text += d.delta
          yield { t: 'assistant_delta', turnId, delta: d.delta }
        } else if (d.type === 'thinking') {
          // 思考/推理内容:只累积,**绝不并进 text、绝不下发给客户端**——否则思维链会被当成回复。
          thinking += d.delta
        } else if (d.type === 'tool_call') {
          calls.push(d.call)
        }
      }
    } catch (err) {
      if (ctx.signal.aborted) {
        yield { t: 'turn_end', turnId, reason: 'aborted' }
        return
      }
      yield { t: 'error', turnId, code: 'model_stream', message: errMsg(err) }
      yield { t: 'turn_end', turnId, reason: 'error' }
      return
    }

    // 【空产出守卫】这一轮既没说话也没调工具(常见于模型只吐了 reasoning、正文为空)。
    // 绝不能落一条空 assistant 消息(那会污染模型历史、并让客户端显示一条空气泡/"发消息没反应")。
    // 给用户一句兜底(不写进模型历史,保持上下文干净),然后结束这一轮。
    if (text.trim() === '' && calls.length === 0) {
      const fallback = thinking.trim()
        ? '（我想了一下但没有给出结论,请再说一次或换个说法。）'
        : '（这一轮没有生成有效回复,请再说一次或换个说法。）'
      yield { t: 'assistant_delta', turnId, delta: fallback }
      yield { t: 'turn_end', turnId, reason: 'stop' }
      return
    }

    const assistant = assistantMessage(text, calls)
    ctx.messages.push(assistant)
    yield { t: 'assistant_message', turnId, message: assistant }

    if (calls.length === 0) {
      yield { t: 'turn_end', turnId, reason: 'stop' }
      return
    }

    for (const call of calls) {
      if (ctx.signal.aborted) {
        yield { t: 'turn_end', turnId, reason: 'aborted' }
        return
      }
      yield* invokeTool(ctx, turnId, call)
    }
  }

  yield { t: 'turn_end', turnId, reason: 'max_steps' }
}

/** 单个工具调用:权限门 → 校验入参 → 执行 → 追加 tool_result。单一出口,永不抛出。 */
async function* invokeTool(ctx: RunCtx, turnId: string, call: ToolCall): AsyncGenerator<AgentEvent> {
  yield { t: 'tool_use', turnId, call }

  let result: unknown
  let isError = false

  const tool = ctx.tools.get(call.name)
  if (!tool) {
    result = `unknown tool: ${call.name}`
    isError = true
  } else {
    const gate = await ctx.permission.check({
      tool: call.name,
      args: call.input,
      meta: ctx.meta,
      signal: ctx.signal,
    })
    const parsed = gate.allow ? tool.inputSchema.safeParse(call.input) : undefined

    if (!gate.allow) {
      result = `permission denied: ${gate.reason}`
      isError = true
    } else if (parsed && !parsed.success) {
      result = `invalid input: ${parsed.error.message}`
      isError = true
    } else {
      const toolCtx: ToolCtx = {
        meta: ctx.meta,
        capability: ctx.capability,
        dispatchToClient: (frame, signal) => ctx.channel.request(ctx.meta.sessionId, frame, signal),
        signal: ctx.signal,
      }
      try {
        for await (const ev of tool.execute(parsed!.data, toolCtx) as AsyncIterable<ToolYield>) {
          if (ev.t === 'progress') {
            yield { t: 'tool_progress', turnId, callId: call.id, msg: ev.msg }
          } else {
            result = ev.result
            isError = ev.isError ?? false
          }
        }
      } catch (err) {
        result = errMsg(err)
        isError = true
      }
    }
  }

  ctx.messages.push(toolResultMessage(call.id, result, isError))
  yield { t: 'tool_result', turnId, callId: call.id, result, isError }
}
