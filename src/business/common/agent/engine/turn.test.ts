import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentEvent, TurnMeta } from '../domain/index.js'
import type { IModelProvider, ModelDelta } from '../model/model.contract.js'
import type { IPermission } from '../permission/permission.contract.js'
import type { ICapability, ITool, IToolRegistry } from '../tools/tool.contract.js'
import type { IClientChannel } from '../session/channel.contract.js'
import type { RunCtx } from './agent.contract.js'
import { runTurn } from './turn.js'

// fakes:证明引擎纯逻辑可脱离 Midway 单测(无网络/无 DB/无 DI 容器)
const meta: TurnMeta = { sessionId: 's1', userId: 'u1' }

function fakeModel(script: ModelDelta[][]): IModelProvider {
  let turn = 0
  return {
    async *stream() {
      for (const d of script[turn++] ?? [{ type: 'stop', reason: 'stop' }]) yield d
    },
  }
}
const allow: IPermission = { check: async () => ({ allow: true }) }
const deny: IPermission = { check: async () => ({ allow: false, reason: 'blocked' }) }
const channel: IClientChannel = { dispatch: async () => ({ ok: true }) }
const capability: ICapability = { describeImage: async () => ({}), generateImage: async () => ({}) }

const echoTool: ITool<{ msg: string }> = {
  name: 'echo',
  description: 'echo',
  inputSchema: z.object({ msg: z.string() }),
  isEnabled: () => true,
  async *execute(input) {
    yield { t: 'progress', msg: 'working' }
    yield { t: 'result', result: input.msg }
  },
}

function registry(tools: ITool[]): IToolRegistry {
  const map = new Map(tools.map((t) => [t.name, t]))
  return {
    get: (n) => map.get(n),
    enabled: () => [...map.values()],
    enabledSpecs: () => [...map.values()].map((t) => ({ name: t.name, description: t.description, parameters: {} })),
  }
}

function ctx(model: IModelProvider, permission: IPermission, tools: ITool[]): RunCtx {
  let n = 0
  return {
    meta,
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: registry(tools),
    model,
    permission,
    capability,
    channel,
    newId: () => `id${n++}`,
    signal: new AbortController().signal,
    maxSteps: 5,
  }
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('runTurn', () => {
  it('无工具:文本后 stop', async () => {
    const events = await collect(
      runTurn(ctx(fakeModel([[{ type: 'text', delta: 'hi' }, { type: 'stop', reason: 'stop' }]]), allow, [])),
    )
    expect(events.map((e) => e.t)).toEqual(['turn_start', 'assistant_delta', 'assistant_message', 'turn_end'])
  })

  it('有工具:tool_use→progress→result→下一轮 stop', async () => {
    const events = await collect(
      runTurn(
        ctx(
          fakeModel([
            [{ type: 'tool_call', call: { id: 'c1', name: 'echo', input: { msg: 'x' } } }],
            [{ type: 'stop', reason: 'stop' }],
          ]),
          allow,
          [echoTool as ITool],
        ),
      ),
    )
    const res = events.find((e) => e.t === 'tool_result')
    expect(res?.t === 'tool_result' && res.result).toBe('x')
    expect(res?.t === 'tool_result' && res.isError).toBe(false)
  })

  it('权限拒绝:配对 isError 的 tool_result', async () => {
    const events = await collect(
      runTurn(
        ctx(
          fakeModel([[{ type: 'tool_call', call: { id: 'c1', name: 'echo', input: { msg: 'x' } } }], [{ type: 'stop', reason: 'stop' }]]),
          deny,
          [echoTool as ITool],
        ),
      ),
    )
    const res = events.find((e) => e.t === 'tool_result')
    expect(res?.t === 'tool_result' && res.isError).toBe(true)
  })

  it('取消:已 abort 立即 turn_end(aborted)', async () => {
    const base = ctx(fakeModel([]), allow, [])
    const ac = new AbortController()
    ac.abort()
    const events = await collect(runTurn({ ...base, signal: ac.signal }))
    const end = events.at(-1)
    expect(end?.t === 'turn_end' && end.reason).toBe('aborted')
  })
})
