import { Provide, Scope, ScopeEnum } from '@midwayjs/core'
import type { AgentEvent } from '../domain/index.js'
import {
  CLIENT_PROTOCOL,
  type DecodedInput,
  type IClientProtocol,
  type WireFrame,
} from './protocol.contract.js'

/**
 * IClientProtocol 的实现:客户端 stream-json 协议的唯一存在处(带版本)。
 * 引擎/工具永不引用 wire 字段名;改协议只动这一个文件。
 * TODO(落地前必做):按现有客户端帧盘清单 + 黄金契约测试,锁死"不改客户端"。
 */
@Provide(CLIENT_PROTOCOL)
@Scope(ScopeEnum.Singleton)
export class StreamJsonCodec implements IClientProtocol {
  readonly version = 'stream-json/v1'

  encode(e: AgentEvent): WireFrame | null {
    switch (e.t) {
      case 'assistant_delta':
        return { type: 'assistant_delta', text: e.delta }
      case 'assistant_message':
        return { type: 'assistant', message: e.message }
      case 'tool_use':
        return { type: 'tool_use', id: e.call.id, name: e.call.name, input: e.call.input }
      case 'tool_result':
        return { type: 'tool_result', id: e.callId, result: e.result, is_error: e.isError }
      case 'turn_end':
        return { type: 'result', reason: e.reason }
      case 'error':
        return { type: 'error', code: e.code, message: e.message }
      default:
        return null // turn_start / tool_progress 默认不下发
    }
  }

  decodeClientMessage(w: WireFrame): DecodedInput {
    // 客户端发 {type:'user_message', content}(content 为字符串或 ContentPart[])
    // 兼容简单 {type:'user', text}
    const rec = w as Record<string, unknown>
    if (Array.isArray(rec.content)) return { content: rec.content as DecodedInput['content'] }
    if (typeof rec.content === 'string') return { content: rec.content }
    const text = typeof rec.text === 'string' ? rec.text : ''
    return { content: text }
  }

  toTranscriptLine(e: AgentEvent): string {
    return JSON.stringify(this.encode(e) ?? { type: `_${e.t}` })
  }
}
