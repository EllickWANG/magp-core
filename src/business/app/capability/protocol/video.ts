/**
 * 生视频协议核心 —— 用 CMS 里指派给「视频」的那个服务商。
 *
 * 和图片的唯一实质区别是**协议是异步的**:视频没有"一次调用直接回字节"的通行协议。
 * 这里走 OpenAI /v1/videos(Sora 系,国内中转普遍照抄这套):
 *   提交任务 → 轮询状态 → 完成后下载 /content。
 * 也兼容同步式返回(个别中转直接回 data[0].url / b64_json)—— 拿到什么认什么。
 *
 * baseURL 用 openaiBaseURL 归一化(缺 /v1 就补),与生图 SDK 的口径一致 —— 用户在后台
 * 无论填不填 /v1 都能对上。
 */
import { openaiBaseURL } from '../../../common/agent/model/protocols/index.js'
import type { ResolvedProvider } from '../../provider/provider.contract.js'

export type GenerateVideoResult =
  | { ok: true; b64: string; mimeType: string }
  | { ok: false; error: string }

/**
 * 总预算 4 分钟。不能再长:客户端主进程的 fetch 等响应最多 5 分钟(videoGen.ts 设的),
 * 这里必须先一步给出结论,否则客户端超时断开、这边还在傻等,用户看到最没用的那种报错。
 * 短视频(几秒)在主流服务商 1~3 分钟内能出;超了就如实说"任务可能还在跑、会照常计费"。
 */
const DEADLINE_MS = 240_000
const POLL_INTERVAL_MS = 5_000

type CreateResponse = {
  id?: string
  status?: string
  error?: { message?: string } | string | null
  data?: { b64_json?: string; url?: string }[]
}

/** 生成一段视频,返回 base64(和图片同一契约,画布那边好共用落盘逻辑)。 */
export async function generateVideo(
  provider: ResolvedProvider,
  prompt: string,
  signal?: AbortSignal,
): Promise<GenerateVideoResult> {
  const started = Date.now()
  const base = openaiBaseURL(provider.baseURL)
  const headers = {
    'content-type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`,
  }

  // 1. 提交任务
  let res: Response
  try {
    res = await fetch(`${base}/videos`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: provider.model, prompt }),
      signal,
    })
  } catch (e) {
    return { ok: false, error: `连不上视频服务商(${base}):${e instanceof Error ? e.message : String(e)}` }
  }

  const text = await res.text()
  if (!res.ok) return { ok: false, error: `视频服务商返回 ${res.status}:${text.slice(0, 300)}` }

  let created: CreateResponse
  try {
    created = JSON.parse(text) as CreateResponse
  } catch {
    return { ok: false, error: `视频服务商返回了非 JSON:${text.slice(0, 200)}` }
  }

  // 同步式返回(个别中转不排队,直接给结果)—— 收下,不走轮询。
  const sync = created.data?.[0]
  if (sync?.b64_json) return { ok: true, b64: sync.b64_json, mimeType: 'video/mp4' }
  if (sync?.url) return download(sync.url, signal)

  if (!created.id) return { ok: false, error: '视频服务商没有返回任务 id,也没有视频数据。' }

  // 2. 轮询任务状态
  let status = created.status ?? 'queued'
  while (status !== 'completed') {
    if (status === 'failed' || status === 'cancelled') {
      return { ok: false, error: `视频生成${status === 'failed' ? '失败' : '被取消'}:${errText(created)}` }
    }
    if (Date.now() - started > DEADLINE_MS) {
      return {
        ok: false,
        error: '视频生成超时(4 分钟)。任务可能还在服务商那边跑(会照常计费),稍后可换个提示词重试。',
      }
    }
    await sleep(POLL_INTERVAL_MS, signal)

    let poll: Response
    try {
      poll = await fetch(`${base}/videos/${created.id}`, { headers, signal })
    } catch (e) {
      return { ok: false, error: `查询视频任务失败:${e instanceof Error ? e.message : String(e)}` }
    }
    const pollText = await poll.text()
    if (!poll.ok) return { ok: false, error: `查询视频任务返回 ${poll.status}:${pollText.slice(0, 200)}` }
    try {
      created = JSON.parse(pollText) as CreateResponse
    } catch {
      return { ok: false, error: `视频服务商返回了非 JSON:${pollText.slice(0, 200)}` }
    }
    status = created.status ?? status
  }

  // 3. 下载成片
  return download(`${base}/videos/${created.id}/content`, signal, headers)
}

function errText(r: CreateResponse): string {
  if (!r.error) return '服务商没说原因'
  return typeof r.error === 'string' ? r.error : (r.error.message ?? '服务商没说原因')
}

async function download(
  url: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<GenerateVideoResult> {
  try {
    const res = await fetch(url, { signal, headers })
    if (!res.ok) return { ok: false, error: `视频下载失败(${res.status}):${url}` }
    const buf = Buffer.from(await res.arrayBuffer())
    const mimeType = res.headers.get('content-type')?.split(';')[0] || 'video/mp4'
    // 中转偶尔把下载地址的 content-type 标成 octet-stream —— 按 mp4 收,别让一条好视频卡在标头上。
    return { ok: true, b64: buf.toString('base64'), mimeType: mimeType.startsWith('video/') ? mimeType : 'video/mp4' }
  } catch (e) {
    return { ok: false, error: `视频下载失败:${e instanceof Error ? e.message : String(e)}` }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('已取消'))
      },
      { once: true },
    )
  })
}
