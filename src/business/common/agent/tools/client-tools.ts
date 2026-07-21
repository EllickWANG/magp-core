import { z } from 'zod'
import type { ICapability, ITool, ToolCtx, ToolYield } from './tool.contract.js'
import type { TurnMeta } from '../domain/index.js'

/**
 * 选品工具目录 —— agent 的**真实的手和眼**。
 *
 * 工具**声明在这**(名字/说明/入参),**实现在客户端**(client/.../agentToolExecutor.ts),
 * 两边靠工具名对齐。绝大多数工具是纯透传:agent 调 → 经 dispatchToClient 发 client_tool_call
 * 给用户桌面客户端执行(内嵌浏览器/看板/画布都在那台机器上)→ 回执兑现。
 *
 * ## 描述就是设计
 *
 * 每条 description 是**写给模型看的行为准则**:开页只能 browser_open_home、了解页面先 browser_snapshot
 * 拿编号、操作全用真实鼠标键盘(browser_click/fill/press_key)、不许拼 URL 直达搜索结果 —— 这套"像真人
 * 一样操作"的纪律(配合客户端的贝塞尔轨迹 + 服务端风控闸门)才是不被电商风控识别的关键。改描述=改行为。
 *
 * ## 三个非透传工具(接 CAPABILITY)
 *
 *  - image_generate:服务端用 image 服务商生成 → 再把图 canvas_add 进客户端画布。
 *  - describe_image / workbench_screenshot:客户端回一张图 → 服务端交 vision 服务商看 → 把文字结论给 agent
 *    (主模型多半看不了图)。
 */

const En = { isEnabled: () => true } as const

/** 纯透传:发 client_tool_call 给客户端执行,回执即结果。 */
function passthrough<I extends Record<string, unknown>>(
  name: string,
  description: string,
  schema: z.ZodType<I>,
): ITool<I> {
  return {
    name,
    description,
    inputSchema: schema,
    ...En,
    async *execute(input: I, ctx: ToolCtx): AsyncIterable<ToolYield> {
      const result = await ctx.dispatchToClient({ tool: name, input: input ?? {} }, ctx.signal)
      yield { t: 'result', result }
    },
  }
}

// ── 定位/入参 schema 片段 ──────────────────────────────────────────
const idsSchema = z.object({ ids: z.array(z.string()).describe('商品 id 列表(来自 board_list)') })
const approvalSchema = z.object({
  approvalId: z.string().optional().describe('用户批准后得到的一次性审批 ID。'),
})

// ── 浏览器:真实的手和眼 ────────────────────────────────────────────
const browserTools: ITool[] = [
  passthrough(
    'browser_open_home',
    '打开平台首页(淘宝、1688 或抖音),带用户登录态。**这是唯一的开页方式** —— agent 没有用 URL 打开' +
      '任意页面的能力,也不存在"拼搜索 URL 直达"这种操作。' +
      '**用户让你打开/去某个平台时,直接调这个工具,不要凭对话记忆假设"它已经开着"就跳过** —— ' +
      '这个工具是幂等的:平台已经开着就只是切回/激活它那个标签,没开就打开,重复调用无害且很便宜。' +
      '浏览器状态可能在两次操作之间变(用户手动切了、应用重启了、标签被关了),所以**以这次调用的真实结果为准,别信旧记忆**。' +
      '开页之后一切都必须像真人一样用真实鼠标键盘:' +
      'browser_click 点搜索框/商品/分类、browser_fill 填关键词、browser_press_key 回车、browser_scroll 滚动。' +
      '搜索示例:browser_open_home(taobao) → browser_click(搜索框) → browser_fill(搜索框,"袜子") → browser_press_key(Enter)。' +
      '看某个商品:在列表页 browser_click 那个商品卡,让页面自己跳过去。用 URL 直达搜索结果/商品页是机器采集特征,会让用户账号被风控。',
    z.object({
      platform: z
        .string()
        .optional()
        .describe('打开哪个平台首页(如 taobao / 1688 / douyin),默认 taobao'),
    }),
  ),
  passthrough(
    'browser_navigate',
    '在内嵌浏览器里打开一个 URL(带用户当前身份的登录态)。用于 browser_open_home 覆盖不到的站点 ——' +
      '任何网址都能开。**但反采集准则不变**:开完页之后一切像真人一样用真实鼠标键盘' +
      '(browser_click / browser_fill / browser_press_key / browser_scroll),' +
      '**不要用它拼搜索结果 URL 或直达深层商品/详情页**(那是机器采集特征,会触发风控)——' +
      '要搜索就开首页再真实输入,要看商品就在列表页点进去。开页会过风控闸门(频控/冷却/拟人停留)。',
    z.object({ url: z.string().describe('要打开的完整网址(http/https)') }),
  ),
  passthrough(
    'browser_snapshot',
    '读内嵌浏览器**当前页面**上可交互的元素,返回一份**带编号的 DOM 文本树**——每行 `[编号]<标签 属性>文字`,' +
      '`\\t` 缩进表示层级,`*[编号]` 表示这是自上一步**新出现**的元素(比如输入后弹出的建议框)。全部来自 DOM,' +
      '又快又准,且只收真正在顶层、没被弹窗遮挡的元素。**这是你了解页面、决定点哪儿/填哪儿的首选**:先 snapshot 拿到' +
      '每个元素的编号,再用 **browser_click(index=编号)** / **browser_fill(index=编号,value=…)** 按编号精确操作——' +
      '编号无歧义、绕开坐标。**不要一上来就 workbench_screenshot**(视觉又慢又贵又易认错位置),只有 snapshot 不够时' +
      '(辨认验证码、判断图片内容/画风、核对视觉布局)才截图。注意:每次 snapshot 编号会重排,以最新一次为准。',
    z.object({}),
  ),
  passthrough(
    'browser_read',
    '读内嵌浏览器**当前页面**上的商品列表,直接入库到用户当前工作台的选品看板,返回识别/新增件数。只适用于商品列表页;读之前会自动整页滚动预热懒加载图片,耗时约 10 秒。',
    z.object({}),
  ),
  passthrough(
    'browser_next_page',
    '在内嵌浏览器的商品列表页里点"下一页"。返回是否翻页成功;失败说明没有下一页按钮,请停止翻页。',
    z.object({}),
  ),
  passthrough(
    'browser_click',
    '在内嵌浏览器里**真实点击**一个元素(真鼠标事件,和用户亲手点一样)。**首选 index** —— ' +
      '先 browser_snapshot 拿到每个元素的编号,再 browser_click(index=编号)。编号无歧义、最稳,还会自动检查' +
      '目标有没有被弹窗遮挡(被挡会告诉你先关弹窗,不会误点浮层)。没有 index 时可退回 text(可见文字)/selector' +
      '(CSS)定位;实在只能靠视觉才用 x/y(CSS 像素,来自 workbench_screenshot)。' +
      '**纪律:每步只做一个动作,点完就 browser_snapshot 看结果再决定下一步,别连续盲点;同一个点击连续失败别超过 3 次——' +
      '换思路(重新 snapshot 拿新编号、先关遮挡弹窗、换个元素、或 ask_human),不要死磕重复同一动作。**',
    z.object({
      index: z.number().optional().describe('元素编号(来自 browser_snapshot,首选、最稳)'),
      text: z.string().optional().describe('元素可见文字(没 index 时用)'),
      selector: z.string().optional().describe('CSS 选择器(text 也定不到时用)'),
      x: z.number().optional().describe('点击横坐标(CSS 像素,仅在都不适用时)'),
      y: z.number().optional().describe('点击纵坐标(CSS 像素)'),
    }),
  ),
  passthrough(
    'browser_fill',
    '在内嵌浏览器里给一个输入框填值(真键盘逐字键入,先聚焦并清空原内容)。**首选 index**(来自 browser_snapshot);' +
      '没有 index 时用 text(输入框 placeholder/label)或 selector 定位。填完通常还要 browser_press_key 回车提交。',
    z.object({
      value: z.string().describe('要填进去的文本'),
      index: z.number().optional().describe('输入框编号(来自 browser_snapshot,首选)'),
      text: z.string().optional().describe('输入框 placeholder / 旁边 label 文字(没 index 时用)'),
      selector: z.string().optional().describe('CSS 选择器(定位用)'),
    }),
  ),
  passthrough(
    'browser_press_key',
    '在内嵌浏览器里按一个键(真键盘)。常用:Enter(提交/搜索)、Tab、Escape、Backspace。填完输入框按 Enter 就能搜索。',
    z.object({ key: z.string().describe('键名,如 Enter / Tab / Escape') }),
  ),
  passthrough(
    'browser_scroll',
    '在内嵌浏览器里滚动页面(真滚轮,触发懒加载/无限滚)。amount 正=向下、负=向上,单位约等于像素;不传默认向下滚一屏。读商品前用 browser_read 会自动预热,这个用于手动浏览更多内容。',
    z.object({ amount: z.number().optional().describe('滚动量,正向下负向上,默认 +800') }),
  ),
]

// ── 选品看板 ────────────────────────────────────────────────────────
const boardTools: ITool[] = [
  passthrough(
    'board_list',
    '列出用户当前工作台选品看板里的商品(id/标题/价格/月销/平台/选中/收藏)。改选中或收藏前先用它拿到商品 id。',
    z.object({}),
  ),
  passthrough(
    'board_select',
    '覆盖式设置看板的选中集合(竞品分析等工具吃的就是选中的商品)。传空数组即清除选中。',
    idsSchema,
  ),
  passthrough('board_star', '覆盖式设置看板的收藏集合。传空数组即清空收藏。', idsSchema),
  passthrough(
    'board_clear',
    '清空当前工作台的整块看板(商品+选中+收藏)。**不可撤销且必须人工审批**。首次调用会返回审批 ID;用户批准后用相同参数加 approvalId 重试。',
    approvalSchema,
  ),
  passthrough(
    'competitor_stats',
    '基于看板**选中**的商品算竞品统计(数量/价格带中位数/平均月销/头部集中度 CR5)。没有选中时基于全部商品。',
    z.object({}),
  ),
]

// ── 自动化 ──────────────────────────────────────────────────────────
const automationTools: ITool[] = [
  passthrough('automation_list', '列出当前工作台的自动化流程(id/名字/步骤数)。', z.object({})),
  passthrough(
    'automation_run',
    '执行当前工作台的一条自动化流程(按 automation_list 拿到的 flowId)。流程在客户端确定性执行,可能持续几分钟。',
    z.object({ flowId: z.string().describe('要执行的流程 id') }),
  ),
]

// ── 制图画布 ────────────────────────────────────────────────────────
const canvasTools: ITool[] = [
  passthrough(
    'canvas_list',
    '列出用户当前工作台制图画布上的图片(id/来源/标注)。',
    z.object({}),
  ),
  passthrough(
    'canvas_pull_products',
    '把看板里**选中**的商品主图拉进制图画布。**画布只用于生图/编辑素材**(改主图、做场景图);' +
      '要给用户看图文结论、做对比展示,一律用 brief_write 写进「简报」(图片先 image_download 下载),不要用画布。',
    z.object({}),
  ),
  passthrough(
    'canvas_clear',
    '清空当前工作台制图画布上的所有图片。**不可撤销且必须人工审批**。首次调用会返回审批 ID;用户批准后用相同参数加 approvalId 重试。',
    approvalSchema,
  ),
]

// ── 简报 / 图片下载 / 岗位 / 附件 ────────────────────────────────────
const outputTools: ITool[] = [
  passthrough(
    'brief_write',
    '把你分析或整理好的东西写成 **markdown**,展示到用户工作台的「简报」面板(覆盖上一次的内容)。' +
      '**这是你向用户呈现结论的默认方式** —— 选品建议、竞品对比、数据整理、图文报告,凡是想让用户看的都写这儿,' +
      '不要动不动开画布。**动态、不限字段**:该用表格就写 markdown 表格,该分点就用列表,要对比就并排列。' +
      '**放图片必须先用 image_download 把图下载到本地**,再用它返回的 magp-media:// 地址写 `![](地址)` —— ' +
      '直接写电商原始图片 URL 会因防盗链变破图。这是给人看的成品,想清楚了再写。',
    z.object({ markdown: z.string().describe('要展示的完整 markdown 内容') }),
  ),
  passthrough(
    'image_download',
    '把一张网络图片(商品主图等)下载到用户工作台本地,返回一个**本地图片地址**(magp-media://…)。' +
      '为什么必须先下载:电商图有防盗链/时效 token,直接引用原始 URL 在页面外就是破图,下载到本地才稳。' +
      '典型用法:要在 brief_write 的 markdown 里放商品图 → 先 image_download 拿到本地地址 → `![](本地地址)`。' +
      '下载走用户登录态,未登录时有些图仍拉不到,那就提示用户先登录。',
    z.object({ url: z.string().describe('图片的 http(s) 原始地址') }),
  ),
  passthrough(
    'board_download_images',
    '把看板里(选中的,没选中就全部)商品的主图**批量下载到本地**,一次返回每件的本地图地址(magp-media://) + 标题。' +
      '**这是给用户看真实商品图的正路**:采集(browser_read)后直接调它,拿到本地地址,写进 brief_write 的 markdown ' +
      '`![](本地地址)`,真实主图就显示出来了 —— 不用逐张 image_download,也不必开画布。' +
      '(下载走用户登录态:浏览器里能正常看到的图,基本都能下下来;未登录拉不到的会跳过。)',
    z.object({}),
  ),
  passthrough(
    'role_get',
    '读当前工作台的**岗位说明和状态**(值班时用)。返回 theme(你的职责)、mode(observe 观察 / auto 自动)、' +
      'cursor(上次处理到哪)、notes(跨轮备忘/待办/草稿)、guidance(本模式的行为约束)。' +
      '**每轮值班开头先调它** —— 你是短命的,上一轮的记忆全在这里,不读就等于失忆上岗。',
    z.object({}),
  ),
  passthrough(
    'role_update',
    '更新岗位状态(值班时用,一轮结束前调):cursor 记"处理到哪了"(如最后处理的消息 id),' +
      'notes 记跨轮备忘/待办/观察模式下待发的草稿。**只传要改的字段**。下一轮的你会用 role_get 读到它 —— 这是记忆接力。',
    z.object({
      cursor: z.string().optional().describe('处理到哪了(下次从这之后继续)'),
      notes: z.string().optional().describe('跨轮备忘 / 待办 / 待发草稿'),
    }),
  ),
  passthrough(
    'attachment_read',
    '安全读取用户上传的非图片附件。消息会给出 attachmentId;支持 TXT、Markdown、JSON、XML、CSV、TSV、PDF、DOCX。' +
      '内容过长时返回 nextCursor,继续用相同 attachmentId 和该 cursor 分页读取。不要使用 Read/Bash 读取客户端路径——' +
      '云端和客户端不共享文件系统。图片请使用 describe_image。',
    z.object({
      attachmentId: z.string().describe('消息中给出的附件资源 ID。'),
      cursor: z.string().optional().describe('上一次返回的 nextCursor;第一次不传。'),
      maxChars: z.number().optional().describe('本页最大字符数,默认 20000,最大 40000。'),
    }),
  ),
  passthrough(
    'ask_human',
    '卡住了,叫人:遇到验证码/需要登录/需要用户做决定时用。会在客户端弹醒目提示,**不等待回复**(用户看到后会在对话里回你)。说清楚卡在哪、需要人做什么。',
    z.object({
      reason: z.string().describe('卡在哪了'),
      needed: z.string().optional().describe('需要人做什么'),
    }),
  ),
]

// ── 非透传:接 CAPABILITY(生图 / 看图) ─────────────────────────────

/** 客户端回的一张图 → 交 vision 服务商看 → 把文字结论给 agent。 */
async function* visionOf(
  payload: unknown,
  question: string | undefined,
  meta: TurnMeta,
  capability: ICapability,
  signal: AbortSignal,
): AsyncIterable<ToolYield> {
  const img = payload as { kind?: string; mimeType?: string; data?: string }
  if (!img || img.kind !== 'image' || !img.data) {
    // 客户端没回图(多半是它那侧的错误文案)—— 原样回给 agent。
    yield { t: 'result', result: payload }
    return
  }
  const url = `data:${img.mimeType || 'image/png'};base64,${img.data}`
  const desc = await capability.describeImage({ url, prompt: question }, meta, signal)
  yield { t: 'result', result: desc }
}

const imageGenerate: ITool<{ prompt: string; size?: string }> = {
  name: 'image_generate',
  description:
    '文生图:按提示词生成一张图片,直接加入用户当前工作台的**制图画布**(选品主图/详情页素材用)。' +
    '生成用 CMS 里配的图片服务商。提示词越具体越好(主体/风格/背景/光线)。生成较慢,通常十几秒到几十秒。',
  inputSchema: z.object({
    prompt: z.string().describe('画什么。越具体越好(主体、风格、背景、光线)'),
    size: z.string().optional().describe('尺寸,如 1024x1024 / 1024x1536,默认 1024x1024'),
  }),
  ...En,
  async *execute(input, ctx): AsyncIterable<ToolYield> {
    yield { t: 'progress', msg: '生成图片中…' }
    const gen = (await ctx.capability.generateImage(
      { prompt: input.prompt },
      ctx.meta,
      ctx.signal,
    )) as { url?: string; b64?: string | null }
    let b64 = gen.b64 ?? null
    let mime = 'image/png'
    if (!b64 && gen.url) {
      // 服务商只给了 url → 下载转 base64(画布要 base64 落盘)。
      const res = await fetch(gen.url, { signal: ctx.signal })
      mime = res.headers.get('content-type') || 'image/png'
      b64 = Buffer.from(await res.arrayBuffer()).toString('base64')
    }
    if (!b64) {
      yield { t: 'result', result: '图片生成失败:服务商没有返回图像数据。', isError: true }
      return
    }
    const r = await ctx.dispatchToClient(
      { tool: 'canvas_add', input: { dataBase64: b64, mimeType: mime, label: input.prompt } },
      ctx.signal,
    )
    yield { t: 'result', result: r }
  },
}

const describeImage: ITool<{ attachmentId: string; question?: string }> = {
  name: 'describe_image',
  description:
    '**查看用户上传的图片附件**,返回文字描述。消息会给出 attachmentId;需要知道图里是什么' +
    '(画风、主体、构图、有没有文字/水印…)时用它。**图片不能用 Read 读**——你的主模型看不了图,' +
    'Read 只会回一句"没有文字";这个工具会把图交给**视觉模型**看,把文字结论给你。' +
    'question 越具体越好("这张图是什么画风?主体是什么?" 好过 "这是什么")。',
  inputSchema: z.object({
    attachmentId: z.string().describe('消息中给出的附件资源 ID,不是文件路径。'),
    question: z.string().optional().describe('你想从图里知道什么。不填给通用描述。'),
  }),
  ...En,
  async *execute(input, ctx): AsyncIterable<ToolYield> {
    const payload = await ctx.dispatchToClient(
      { tool: 'describe_image', input: { attachmentId: input.attachmentId } },
      ctx.signal,
    )
    yield* visionOf(payload, input.question, ctx.meta, ctx.capability, ctx.signal)
  },
}

const workbenchScreenshot: ITool<{ question?: string }> = {
  name: 'workbench_screenshot',
  description:
    '看一眼用户客户端工作台的当前画面(浏览器在台上时看网页可视区,否则看工具界面)。' +
    '**返回的是文字描述,不是图片** —— 画面会交给视觉模型看,你拿到的是它的回答。' +
    '**这是视觉兜底,不是首选**:想知道页面上有哪些能点/能填的东西,先用 browser_snapshot(DOM,又快又准);' +
    '截图只用于 snapshot 给不了的**视觉判断** —— 有没有验证码/登录框/报错、图片长什么样、布局对不对。' +
    'question 问得越具体,答得越有用("有没有滑块验证码?在哪个位置?" 远好于 "这是什么")。' +
    '**连续截图/多步长任务时,每步之前先用一句话说你现在在做什么、看到了什么(边做边说),' +
    '别把所有说明憋到最后一次性输出 —— 用户在看你实时干活,想同步知道进度,而不是等你干完才收到一大段总结。**',
  inputSchema: z.object({
    question: z.string().optional().describe('你想从画面里知道什么。越具体越好。不填则给一个通用描述。'),
  }),
  ...En,
  async *execute(input, ctx): AsyncIterable<ToolYield> {
    const payload = await ctx.dispatchToClient(
      { tool: 'workbench_screenshot', input: {} },
      ctx.signal,
    )
    yield* visionOf(payload, input.question, ctx.meta, ctx.capability, ctx.signal)
  },
}

// ── 视觉定位点击:DOM 够不着时的**精确**兜底 ─────────────────────────

type Shot = { data?: string; mimeType?: string; width?: number; height?: number }
type Region = Shot & { originX?: number; originY?: number; scale?: number; signature?: number[] }

/** 两张 8×8 灰度签名的平均差 —— 判断点击前后这块区域变没变(不花模型调用)。 */
function sigDiff(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i += 1) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0))
  return sum / n
}

const clickVisual: ITool<{ target: string }> = {
  name: 'browser_click_visual',
  description:
    '**用视觉精确定位并点击**一个你能在画面上看见、但 browser_snapshot 抽不到的元素。' +
    '截图 → 视觉模型框出目标 → 用真鼠标点它的中心 → 再截图验证画面有没有变化,全自动。' +
    '**什么时候用**:browser_snapshot 里找不到目标(元素在跨源 iframe、canvas、closed shadow DOM,' +
    '或者是纯图片按钮)时。**首选仍然是 browser_snapshot + browser_click(index=编号)** —— DOM 编号最准也最便宜,' +
    '视觉定位是它够不着时的兜底。' +
    'target 要**描述得能被一眼认出**:说清它是什么、在哪、长什么样("登录弹窗右上角的关闭 × 按钮" ' +
    '远好于 "关闭按钮")。返回会告诉你点在了哪、画面有没有因此变化 —— 没变化就别重复点同一个地方,' +
    '换个描述或改用 ask_human。',
  inputSchema: z.object({
    target: z
      .string()
      .describe('要点什么。描述得越具体越好:它是什么、在画面哪个位置、长什么样。'),
  }),
  ...En,
  async *execute(input, ctx): AsyncIterable<ToolYield> {
    // ① SEE —— 截图 + 拿到它的 CSS 尺寸(坐标契约就建在这个尺寸上)
    yield { t: 'progress', msg: `视觉定位:${input.target}` }
    const shot = (await ctx.dispatchToClient({ tool: 'capture_view', input: {} }, ctx.signal)) as Shot
    if (!shot?.data || !shot.width || !shot.height) {
      yield { t: 'result', result: '截不到画面,无法视觉定位。', isError: true }
      return
    }

    // ② GROUND —— 整图一次定位。
    //
    // **为什么不再默认做「裁剪放大再定位一遍」**:实测(claude-opus-4-8,1280×800 合成界面,
    // 6 个不同大小的目标)全图单次定位误差 0~1px,连 18px 高的小链接都是 0px,6/6 全部落在元素内。
    // 那一遍精定位要多花一次模型调用 + 两次截图,却换不来可测量的收益 —— 砍掉。
    // 只在模型**自己说没把握**时才补一遍(见下)。
    const loc = await ctx.capability.locateInImage(
      { imageBase64: shot.data, mimeType: shot.mimeType ?? 'image/jpeg', width: shot.width, height: shot.height, target: input.target },
      ctx.meta,
      ctx.signal,
    )
    if (!loc.found || !loc.box) {
      yield {
        t: 'result',
        result: `视觉定位没找到「${input.target}」${loc.note ? `(${loc.note})` : ''}。换个更具体的描述再试;若这是登录/验证弹窗,请用 ask_human 让用户处理。`,
        isError: true,
      }
      return
    }

    let box = loc.box
    let region: { x: number; y: number; w: number; h: number } | null = null
    let before: number[] | undefined

    // ③ 低置信才补一遍精定位:裁出目标附近放大 3 倍再问一次。
    //    小目标在整图里只有几个像素时,这一步能救回来;置信高时不花这个钱。
    if ((loc.confidence ?? 1) < 0.7) {
      yield { t: 'progress', msg: '置信偏低,裁剪放大后重新定位' }
      const padX = Math.max(60, box.w), padY = Math.max(60, box.h)
      region = {
        x: Math.max(0, box.x - padX),
        y: Math.max(0, box.y - padY),
        w: Math.min(shot.width, box.w + padX * 2),
        h: Math.min(shot.height, box.h + padY * 2),
      }
      const crop = (await ctx.dispatchToClient({ tool: 'capture_region', input: { ...region, scale: 3 } }, ctx.signal)) as Region
      if (crop?.data && crop.width && crop.height) {
        before = crop.signature
        const fine = await ctx.capability.locateInImage(
          { imageBase64: crop.data, mimeType: crop.mimeType ?? 'image/jpeg', width: crop.width, height: crop.height, target: input.target },
          ctx.meta,
          ctx.signal,
        )
        if (fine.found && fine.box) {
          const k = crop.scale && crop.scale > 0 ? crop.scale : 1
          box = {
            x: (crop.originX ?? region.x) + fine.box.x / k,
            y: (crop.originY ?? region.y) + fine.box.y / k,
            w: fine.box.w / k,
            h: fine.box.h / k,
          }
        }
      }
    }

    // ④ ACT —— 交给真鼠标(clickTab 会把 CSS 坐标校准成 view 物理坐标,走贝塞尔轨迹)
    const x = Math.round(box.x + box.w / 2)
    const y = Math.round(box.y + box.h / 2)
    yield { t: 'progress', msg: `点击 (${x}, ${y})` }
    await ctx.dispatchToClient({ tool: 'browser_click', input: { x, y } }, ctx.signal)

    // ⑤ VERIFY —— 同一块区域再截一次比 8×8 灰度签名。**不花模型调用**,却是这条链路最值钱的一步:
    //    原来那次失败,agent 就是不知道自己点空了,于是对着同一个位置连点了八次。
    if (!region) {
      region = {
        x: Math.max(0, box.x - 40),
        y: Math.max(0, box.y - 40),
        w: Math.min(shot.width, box.w + 80),
        h: Math.min(shot.height, box.h + 80),
      }
      const pre = (await ctx.dispatchToClient({ tool: 'capture_region', input: { ...region, scale: 1 } }, ctx.signal)) as Region
      before = pre?.signature
    }
    let changed: boolean | null = null
    if (before) {
      const after = (await ctx.dispatchToClient({ tool: 'capture_region', input: { ...region, scale: 1 } }, ctx.signal)) as Region
      if (after?.signature) changed = sigDiff(before, after.signature) > 6
    }
    yield {
      t: 'result',
      result:
        changed === false
          ? `已按视觉定位点击「${input.target}」于 (${x}, ${y}),但**画面没有变化** —— 多半没点中,或这个元素点了也不响应。` +
            `不要在同一位置重复点:换更具体的描述重试一次,仍不行就用 ask_human 让用户手动处理(跨源的登录/风控弹窗尤其如此)。`
          : `已按视觉定位点击「${input.target}」于 (${x}, ${y})${changed ? ',画面已发生变化' : ''}。` +
            `可再 browser_snapshot 或 workbench_screenshot 确认结果。`,
    }
  },
}

/** 全部选品工具(model-facing)。canvas_add 是内部工具(image_generate 用),不进目录。 */
export const CLIENT_TOOLS: ITool[] = [
  ...browserTools,
  ...boardTools,
  ...automationTools,
  ...canvasTools,
  ...outputTools,
  imageGenerate as ITool,
  describeImage as ITool,
  workbenchScreenshot as ITool,
  clickVisual as ITool,
]
