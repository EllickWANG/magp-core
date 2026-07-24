import OpenAI from 'openai'
import type { ContentPart, Message } from '../../domain/index.js'
import type { ModelDelta, ModelStreamRequest } from '../model.contract.js'
import type { ModelConfig } from '../model-config.contract.js'
import type { ApiFormat, IChatProtocol } from './protocol.contract.js'
import { openaiBaseURL } from './url.js'

/**
 * OpenAI Chat Completions(`POST /v1/chat/completions`)。
 *
 * **deepseek 原生也走这条**:它的对话接口就是 OpenAI 兼容的 /chat/completions,
 * 差别只在多回一个 `reasoning_content`(思维链)。我们把它当普通文本流出去 ——
 * 丢掉的话,用户会看到 agent "想了很久然后一言不发"。
 */
export class OpenAIChatProtocol implements IChatProtocol {
  constructor(readonly format: ApiFormat = 'openai_chat') {}

  private client(cfg: ModelConfig, timeout?: number): OpenAI {
    return new OpenAI({
      baseURL: openaiBaseURL(cfg.baseURL),
      apiKey: cfg.apiKey,
      ...(timeout ? { timeout, maxRetries: 0 } : {}),
    })
  }

  async *stream(cfg: ModelConfig, req: ModelStreamRequest): AsyncIterable<ModelDelta> {
    const stream = await this.client(cfg).chat.completions.create(
      {
        model: cfg.model,
        stream: true,
        messages: toOpenAIMessages(req.system, req.messages),
        ...(req.tools.length > 0
          ? {
              tools: req.tools.map((t) => ({
                type: 'function' as const,
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters as Record<string, unknown>,
                },
              })),
            }
          : {}),
      },
      { signal: req.signal },
    )

    const acc = new Map<number, { id: string; name: string; args: string }>()
    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) continue
      // deepseek 的 reasoning_content / 部分中转把 OpenAI 推理模型的 reasoning 也塞这个字段。
      // 走**独立的 thinking 通道**,不能当正文——否则整段思维链会被当成 agent 的回复发给用户。
      const d = choice.delta as (typeof choice.delta) & { reasoning_content?: string; reasoning?: string }
      const reasoning = d?.reasoning_content ?? d?.reasoning
      if (reasoning) yield { type: 'thinking', delta: reasoning }
      if (d?.content) yield { type: 'text', delta: d.content }
      for (const tc of d?.tool_calls ?? []) {
        const cur = acc.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name = tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        acc.set(tc.index, cur)
      }
      if (choice.finish_reason) {
        for (const c of acc.values()) {
          yield { type: 'tool_call', call: { id: c.id, name: c.name, input: safeJson(c.args) } }
        }
        yield { type: 'stop', reason: mapReason(choice.finish_reason) }
      }
    }
  }

  async ping(cfg: ModelConfig, signal: AbortSignal): Promise<void> {
    await this.client(cfg, 30_000).chat.completions.create(
      { model: cfg.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
      { signal },
    )
  }
}

const safeJson = (s: string): unknown => {
  try {
    return s ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}
const mapReason = (r: string): 'stop' | 'length' | 'tool_calls' =>
  r === 'tool_calls' ? 'tool_calls' : r === 'length' ? 'length' : 'stop'

function toOpenAIMessages(
  system: string,
  messages: readonly Message[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: textOf(m.content) })
    } else if (m.role === 'assistant') {
      const toolCalls = m.content
        .filter((p): p is Extract<ContentPart, { type: 'tool_use' }> => p.type === 'tool_use')
        .map((p) => ({
          id: p.id,
          type: 'function' as const,
          function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
        }))
      out.push({
        role: 'assistant',
        content: textOf(m.content) || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    } else {
      for (const p of m.content) {
        if (p.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: p.id,
            content: typeof p.result === 'string' ? p.result : JSON.stringify(p.result),
          })
        }
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
