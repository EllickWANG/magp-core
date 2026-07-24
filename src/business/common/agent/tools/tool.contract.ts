import type { z } from 'zod'
import type { TurnMeta } from '../domain/index.js'

/** 解耦② 工具/能力 的接口契约 + 注入 token。 */
export const TOOL_REGISTRY = 'agent:tool-registry'
export const CAPABILITY = 'agent:capability'

/** 能力(看图/生图):in-process 调 control-plane 能力服务 + 记账。 */
/** 视觉定位结果:坐标是**给定图片的像素空间**(调用方传了 width/height,实现负责把归一化空间映射回来)。 */
export interface GroundingBox {
  x: number
  y: number
  w: number
  h: number
}
export interface GroundingResult {
  found: boolean
  box?: GroundingBox
  confidence?: number
  /** 模型的说明(没找到的原因等),给 agent 看。 */
  note?: string
}

export interface ICapability {
  describeImage(input: { url: string; prompt?: string }, meta: TurnMeta, signal: AbortSignal): Promise<unknown>
  generateImage(input: { prompt: string }, meta: TurnMeta, signal: AbortSignal): Promise<unknown>
  /** 生视频(异步:提交→轮询→下载)。用指派给「视频」能力的服务商;协议失败返回 {ok:false} 不抛。 */
  generateVideo(
    input: { prompt: string },
    meta: TurnMeta,
    signal: AbortSignal,
  ): Promise<{ ok: true; b64: string; mimeType: string } | { ok: false; error: string }>
  /**
   * **视觉定位(grounding)**:在图里找出目标元素的精确 bbox。
   * 和 describeImage 的本质区别:那个要的是"描述"(坐标只是散文里的约数,必然不准),
   * 这个要的是**结构化坐标**——必须告诉模型图的确切像素尺寸、强制它只回 JSON bbox。
   */
  locateInImage(
    input: { imageBase64: string; mimeType: string; width: number; height: number; target: string },
    meta: TurnMeta,
    signal: AbortSignal,
  ): Promise<GroundingResult>
}

/** 工具执行上下文:副作用只经这里注入的能力,不许直接摸 ws/db/网络。 */
export interface ToolCtx {
  readonly meta: TurnMeta
  readonly capability: ICapability
  /** 给客户端下指令并等回执(client_tool_call → client_tool_result;由 IClientChannel.request 提供)。 */
  dispatchToClient(frame: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  readonly signal: AbortSignal
}

export type ToolYield =
  | { readonly t: 'progress'; readonly msg: string }
  | { readonly t: 'result'; readonly result: unknown; readonly isError?: boolean }

export interface ITool<I = unknown> {
  readonly name: string
  readonly description: string
  readonly inputSchema: z.ZodType<I>
  isEnabled(meta: TurnMeta): boolean
  execute(input: I, ctx: ToolCtx): AsyncIterable<ToolYield>
}

export interface IToolRegistry {
  get(name: string): ITool | undefined
  enabled(meta: TurnMeta): ITool[]
  enabledSpecs(meta: TurnMeta): { name: string; description: string; parameters: unknown }[]
}
