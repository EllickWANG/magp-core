import { Inject, Provide, Scope, ScopeEnum } from '@midwayjs/core'
import {
  MODEL_PROVIDER,
  type IModelProvider,
  type ModelDelta,
  type ModelStreamRequest,
} from './model.contract.js'
import { MODEL_CONFIG_SOURCE, type IModelConfigSource } from './model-config.contract.js'
import { protocolFor } from './protocols/index.js'

/** 上游抖动最多重试几次(仅限**一个字都还没吐出去**时)。 */
const MAX_RETRIES = 2
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 这次失败是「上游抽风」还是「配置错了」?
 *
 * 只有前者才值得重试:socket 被掐、连接超时、DNS 抖动。
 * 4xx(模型名不对、没权限、参数非法)重试多少次都是同样的结果,只是白等。
 */
function isTransient(e: unknown): boolean {
  const err = e as { status?: number; message?: string; code?: string; cause?: { code?: string; message?: string } }
  if (typeof err?.status === 'number' && err.status < 500) return false
  const code = err?.code ?? err?.cause?.code ?? ''
  if (['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'].includes(code)) return true
  const msg = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`
  return /fetch failed|socket|Connection error|network|terminated|timed out/i.test(msg)
}

/**
 * 把连接层异常翻成**有信息量**的一句话。
 *
 * OpenAI SDK 在底层 fetch 失败时一律抛「Connection error.」—— 这句话对排查毫无帮助。
 * 真正的线索在 `cause.code` 里,必须挖出来。
 *
 * **但只报现象,不下断言**:连接被掐可能是上游中转,也可能是本机代理/VPN、公司网关、
 * 甚至 DNS —— 从这一端根本分不清。写死"中转不稳定"会把排查的人直接带偏一整天
 * (这事刚发生过:同样的 UND_ERR_SOCKET,真凶是本机代理,不是中转)。所以列出可能性,让人自己排。
 */
function describe(e: unknown, attempts: number): Error {
  const err = e as { message?: string; code?: string; cause?: { code?: string; message?: string } }
  const code = err?.code ?? err?.cause?.code
  const tried = attempts > 0 ? `(已重试 ${attempts} 次)` : ''
  const NET_HINT = '排查顺序:先确认本机代理/VPN 是否在拦截,再看服务商 Base URL,最后才怀疑上游'
  if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || /socket/i.test(String(err?.cause?.message ?? ''))) {
    return new Error(`连接被中断${tried}(${code ?? 'socket error'})。${NET_HINT}`)
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || /timed out/i.test(String(err?.message ?? ''))) {
    return new Error(`连接/响应超时${tried}(${code ?? 'timeout'})。${NET_HINT}`)
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new Error(`域名解析失败${tried}(${code})—— 检查服务商 Base URL 的域名,以及本机 DNS/代理`)
  }
  const raw = err?.message ?? String(e)
  // 兜底:至少把 cause 的 code 附上,别让「Connection error.」孤零零地出现在界面上。
  return new Error(code && !raw.includes(code) ? `${raw}${tried}(${code})` : `${raw}${tried}`)
}

/**
 * IModelProvider 的实现:**按服务商配置的协议分流**到对应的原生实现,并兜住上游抖动。
 *
 * 之前这里写死了 OpenAI Chat —— 于是 CMS 里明明能选 claude 原生 / OpenAI Responses,
 * 运行时却一律当 OpenAI Chat 调,选了就一路失败,而界面上只表现为「agent 不回话」。
 * 现在协议随 provider 走(见 protocols/),CMS 选什么就真按什么调。
 *
 * ## 重试的边界:**只在一个字都还没吐出去时重试**
 *
 * 流式一旦开始输出,内容就已经到用户眼前了 —— 这时重试会让同一段话出现两遍,
 * 比直接失败更糟。所以只补救「连都没连上」那一类失败;开始输出之后出的错,如实报出来。
 */
@Provide(MODEL_PROVIDER)
@Scope(ScopeEnum.Singleton)
export class MultiProtocolModelProvider implements IModelProvider {
  @Inject(MODEL_CONFIG_SOURCE) private readonly configSource!: IModelConfigSource

  async *stream(req: ModelStreamRequest): AsyncIterable<ModelDelta> {
    const cfg = await this.configSource.resolve(req.meta)
    const proto = protocolFor(cfg.apiFormat)

    for (let attempt = 0; ; attempt += 1) {
      let emitted = false
      try {
        for await (const d of proto.stream(cfg, req)) {
          emitted = true
          yield d
        }
        return
      } catch (e) {
        const retryable = !emitted && attempt < MAX_RETRIES && isTransient(e) && !req.signal.aborted
        if (!retryable) throw describe(e, attempt)
        // 退避:200ms → 600ms。中转掐连接多是瞬时的,等一下往往就好。
        await sleep(200 * 3 ** attempt)
      }
    }
  }
}
