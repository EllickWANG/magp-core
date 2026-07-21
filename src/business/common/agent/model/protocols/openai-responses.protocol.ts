import OpenAI from 'openai'
import type { ContentPart, Message } from '../../domain/index.js'
import type { ModelDelta, ModelStreamRequest } from '../model.contract.js'
import type { ModelConfig } from '../model-config.contract.js'
import type { IChatProtocol } from './protocol.contract.js'
import { apiUrl } from './url.js'

/**
 * OpenAI Responses API(`POST /v1/responses`)—— OpenAI 的新一代原生协议。
 *
 * 和 Chat Completions 的差异:
 *  - 请求体是 `input`(条目数组)而不是 `messages`;system 走 `instructions`;
 *  - 工具是**扁平的** `{type:'function', name, parameters}`,不再套一层 function;
 *  - 工具结果是 `function_call_output` 条目(带 call_id),不是 role:'tool' 的消息;
 *  - 流式是**有类型的事件**(response.output_text.delta / response.function_call_arguments.delta …),
 *    不是 choices[0].delta。
 *
 * 用 fetch 手拼而不用 SDK 的 responses 辅助方法:各家中转对 Responses 的支持参差,
 * 手拼能保证请求体完全可控,出问题时也能把上游原文直接带给用户看。
 */
export class OpenAIResponsesProtocol implements IChatProtocol {
  readonly format = 'openai_responses' as const

  async *stream(cfg: ModelConfig, req: ModelStreamRequest): AsyncIterable<ModelDelta> {
    const res = await post(
      cfg,
      {
        model: cfg.model,
        stream: true,
        instructions: req.system || undefined,
        input: toResponsesInput(req.messages),
        ...(req.tools.length > 0
          ? {
              tools: req.tools.map((t) => ({
                type: 'function' as const,
                name: t.name,
                description: t.description,
                parameters: t.parameters as Record<string, unknown>,
              })),
            }
          : {}),
      },
      req.signal,
    )

    // 工具调用按 item 累积:名字/call_id 在 output_item.added 里,入参分片在 arguments.delta 里。
    const calls = new Map<string, { id: string; name: string; args: string }>()
    let stopReason: 'stop' | 'length' | 'tool_calls' = 'stop'

    for await (const ev of sseEvents(res, req.signal)) {
      const t = ev.type as string | undefined
      if (t === 'response.output_text.delta') {
        const d = ev.delta
        if (typeof d === 'string' && d) yield { type: 'text', delta: d }
      } else if (t === 'response.output_item.added') {
        const item = ev.item as { type?: string; id?: string; call_id?: string; name?: string } | undefined
        if (item?.type === 'function_call') {
          calls.set(String(ev.item_id ?? item.id ?? item.call_id ?? ''), {
            id: item.call_id ?? item.id ?? '',
            name: item.name ?? '',
            args: '',
          })
        }
      } else if (t === 'response.function_call_arguments.delta') {
        const cur = calls.get(String(ev.item_id ?? ''))
        if (cur && typeof ev.delta === 'string') cur.args += ev.delta
      } else if (t === 'response.completed' || t === 'response.incomplete') {
        for (const c of calls.values()) {
          stopReason = 'tool_calls'
          yield { type: 'tool_call', call: { id: c.id, name: c.name, input: safeJson(c.args) } }
        }
        if (t === 'response.incomplete') stopReason = 'length'
        yield { type: 'stop', reason: stopReason }
      }
    }
  }

  async ping(cfg: ModelConfig, signal: AbortSignal): Promise<void> {
    const res = await post(
      cfg,
      { model: cfg.model, input: 'ping', max_output_tokens: 16 },
      signal,
    )
    await res.text()
  }
}

async function post(cfg: ModelConfig, body: unknown, signal: AbortSignal): Promise<Response> {
  const res = await fetch(apiUrl(cfg.baseURL, '/responses'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = new Error(`OpenAI Responses ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return res
}

async function* sseEvents(res: Response, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = res.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, sep)
        buf = buf.slice(sep).replace(/^\r?\n\r?\n/, '')
        for (const line of raw.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            yield JSON.parse(payload) as Record<string, unknown>
          } catch {
            /* 半截 JSON,丢掉 */
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** 我们的 Message[] → Responses 的 input 条目数组。 */
function toResponsesInput(messages: readonly Message[]): unknown[] {
  const out: unknown[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'input_text', text: textOf(m.content) }] })
      continue
    }
    if (m.role === 'assistant') {
      const text = textOf(m.content)
      if (text) out.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const p of m.content) {
        if (p.type === 'tool_use') {
          out.push({ type: 'function_call', call_id: p.id, name: p.name, arguments: JSON.stringify(p.input ?? {}) })
        }
      }
      continue
    }
    for (const p of m.content) {
      if (p.type === 'tool_result') {
        out.push({
          type: 'function_call_output',
          call_id: p.id,
          output: typeof p.result === 'string' ? p.result : JSON.stringify(p.result),
        })
      }
    }
  }
  return out
}

const textOf = (content: readonly ContentPart[]): string =>
  content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')

const safeJson = (s: string): unknown => {
  try {
    return s ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}
