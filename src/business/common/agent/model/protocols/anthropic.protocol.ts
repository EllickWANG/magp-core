import type { ContentPart, Message } from '../../domain/index.js'
import type { ModelDelta, ModelStreamRequest } from '../model.contract.js'
import type { ModelConfig } from '../model-config.contract.js'
import type { IChatProtocol } from './protocol.contract.js'
import { apiUrl } from './url.js'

/**
 * Claude 原生协议(Anthropic Messages API,`POST /v1/messages`)。
 *
 * 和 OpenAI Chat 的四处**根本差异**(照搬 OpenAI 那套必然坏):
 *  1. **鉴权是 x-api-key + anthropic-version**,不是 Bearer;
 *  2. **system 不是一条消息**,是顶层字段;
 *  3. **工具结果不是 role:'tool' 的消息**,是 user 消息里的 `tool_result` 内容块,
 *     而且要**并进上一条 user 消息**(新起一条会打乱 assistant→结果 的配对);
 *  4. **max_tokens 必填**,流式是有类型的事件(content_block_start/delta/stop…),
 *     工具入参以 `input_json_delta` 分片到达,要按块累积成完整 JSON。
 *
 * 协议细节对齐 Nexus 的 anthropic 适配器(它由 new-api 移植,踩过的坑都在里面)。
 * 手写 fetch 而不引 SDK:官方 SDK 会往 baseURL 追加 `/v1/messages`,而 Magp 的 baseUrl
 * 约定是**已经带 /v1**,接上去会变成 `/v1/v1/messages`。自己拼反而稳(见 url.ts)。
 */
export class AnthropicProtocol implements IChatProtocol {
  readonly format = 'anthropic' as const

  async *stream(cfg: ModelConfig, req: ModelStreamRequest): AsyncIterable<ModelDelta> {
    const res = await post(
      cfg,
      {
        model: cfg.model,
        max_tokens: 8192, // 必填;给足,免得长回答被截断
        stream: true,
        system: req.system || undefined,
        messages: toAnthropicMessages(req.messages),
        ...(req.tools.length > 0
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: { type: 'object', ...(t.parameters as Record<string, unknown>) },
              })),
            }
          : {}),
      },
      req.signal,
    )

    // 按内容块累积:文本直接流出;工具入参要等这一块收完才拼得成合法 JSON。
    const blocks = new Map<number, { type: string; id: string; name: string; json: string }>()
    let stopReason: 'stop' | 'length' | 'tool_calls' = 'stop'

    for await (const ev of sseEvents(res, req.signal)) {
      switch (ev.type) {
        case 'content_block_start': {
          const b = ev.content_block as { type?: string; id?: string; name?: string } | undefined
          blocks.set(ev.index as number, {
            type: b?.type ?? 'text',
            id: b?.id ?? '',
            name: b?.name ?? '',
            json: '',
          })
          break
        }
        case 'content_block_delta': {
          const d = ev.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined
          if (d?.type === 'text_delta' && d.text) {
            yield { type: 'text', delta: d.text }
          } else if (d?.type === 'thinking_delta' && d.thinking) {
            // 扩展思考的思维链:走独立 thinking 通道,别丢(旧实现丢弃它 → thinking-only 轮次正文恒空)、
            // 更不能当正文。仅在模型开了 thinking 时出现。
            yield { type: 'thinking', delta: d.thinking }
          } else if (d?.type === 'input_json_delta' && d.partial_json) {
            const cur = blocks.get(ev.index as number)
            if (cur) cur.json += d.partial_json
          }
          break
        }
        case 'content_block_stop': {
          const cur = blocks.get(ev.index as number)
          if (cur?.type === 'tool_use') {
            yield { type: 'tool_call', call: { id: cur.id, name: cur.name, input: safeJson(cur.json) } }
          }
          break
        }
        case 'message_delta':
          stopReason = mapStopReason((ev.delta as { stop_reason?: string } | undefined)?.stop_reason)
          break
        case 'message_stop':
          yield { type: 'stop', reason: stopReason }
          break
        default:
          break
      }
    }
  }

  /** 探活:max_tokens=1 的最小 messages 请求 —— 通了就说明 URL / key / 模型 / 协议四件事都对。 */
  async ping(cfg: ModelConfig, signal: AbortSignal): Promise<void> {
    const res = await post(
      cfg,
      { model: cfg.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
      signal,
    )
    await res.text()
  }
}

async function post(cfg: ModelConfig, body: unknown, signal: AbortSignal): Promise<Response> {
  const res = await fetch(apiUrl(cfg.baseURL, '/messages'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // 带出上游原文:Anthropic 的错误体通常写清了是模型名不对、余额不足还是参数非法。
    const err = new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return res
}

/** SSE 解析:只取 `data:` 行(Anthropic 把事件类型写在 payload 的 type 里,不必读 event: 行)。 */
async function* sseEvents(
  res: Response,
  signal: AbortSignal,
): AsyncGenerator<Record<string, unknown> & { type?: string; index?: number }> {
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
      // 事件以空行分隔;\r\n 也要认(有些网关会改写换行)。
      while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, sep)
        buf = buf.slice(sep).replace(/^\r?\n\r?\n/, '')
        for (const line of raw.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            yield JSON.parse(payload)
          } catch {
            /* 半截 JSON —— 丢这一条,别让它把整条流带崩 */
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

const mapStopReason = (r: string | undefined): 'stop' | 'length' | 'tool_calls' =>
  r === 'tool_use' ? 'tool_calls' : r === 'max_tokens' ? 'length' : 'stop'

/**
 * 我们的 Message[] → Anthropic messages。
 *
 * 关键:**工具结果并进上一条 user 消息**(不是新起一条,也不是 role:'tool')。
 * Anthropic 要求 assistant 的 tool_use 之后紧跟着承载 tool_result 的 user 消息;
 * 拆成多条会让上游判定对话结构非法(400),而错误信息通常只说 "unexpected role"。
 */
function toAnthropicMessages(messages: readonly Message[]): unknown[] {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: textOf(m.content) }] })
      continue
    }
    if (m.role === 'assistant') {
      const content: unknown[] = []
      const text = textOf(m.content)
      if (text) content.push({ type: 'text', text })
      for (const p of m.content) {
        if (p.type === 'tool_use') {
          content.push({ type: 'tool_use', id: p.id, name: p.name, input: p.input ?? {} })
        }
      }
      out.push({ role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '' }] })
      continue
    }
    for (const p of m.content) {
      if (p.type !== 'tool_result') continue
      const block = {
        type: 'tool_result',
        tool_use_id: p.id,
        content: typeof p.result === 'string' ? p.result : JSON.stringify(p.result),
        ...(p.isError ? { is_error: true } : {}),
      }
      const last = out[out.length - 1]
      if (last?.role === 'user') last.content.push(block)
      else out.push({ role: 'user', content: [block] })
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
