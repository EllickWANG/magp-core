/**
 * 手势规划 —— **"真正的手"的核心算法**(从旧 control-plane gesture.service.ts 原样移植)。
 *
 * 对手在网页里能录到 mousemove 序列;让这串序列像真人手的关键(贝塞尔弧线、变速、过冲、
 * 时序分布)就是这里的算法。算法只在服务端(core):**用户设备上没有这套算法**,解包/反汇编都拿不到 ——
 * 客户端(inputEngine)只收到一串算好的 `{x,y,dt}` 照着 replay(replay 没有 IP,就是把坐标喂给 sendInputEvent)。
 * plan 每次带随机、样本各不同,从 replay 反推算法也难。
 *
 * 坐标是 **CSS 像素**(客户端 replay 时再换 view 物理像素);viewSize 由客户端给(它才知道本地尺寸)。
 */

export type Pt = { x: number; y: number }

const rand = (a: number, b: number): number => a + Math.random() * (b - a)
const randInt = (a: number, b: number): number => Math.round(rand(a, b))
const randSign = (): number => (Math.random() < 0.5 ? -1 : 1)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y)
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
function perp(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x,
    dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return { x: -dy / len, y: dx / len }
}
function unit(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x,
    dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return { x: dx / len, y: dy / len }
}
const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
function cubicBezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t,
    a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  }
}

export type Move = { x: number; y: number; dt: number }
export type GesturePlan = {
  moves: Move[]
  press?: { hoverMs: number; downMs: number }
}

type View = { w: number; h: number }

/** 移动到 (to):贝塞尔弧线 + 变速采样 + 末端过冲回修。from=null → 从视口中心起。 */
export function planMove(from: Pt | null, to: Pt, view: View): GesturePlan {
  const w = view.w > 0 ? view.w : 1200
  const h = view.h > 0 ? view.h : 800
  const P0 = from ?? { x: w / 2, y: h / 2 }
  const P3 = { x: clamp(to.x, 0, w - 1), y: clamp(to.y, 0, h - 1) }
  const d = dist(P0, P3)
  const moves: Move[] = []
  if (d < 2) {
    moves.push({ x: P3.x, y: P3.y, dt: 0 })
    return { moves }
  }
  const n = perp(P0, P3)
  const arc = clamp(d * rand(0.1, 0.25), 8, 120)
  const s = randSign()
  const m1 = lerp(P0, P3, 0.33)
  const m2 = lerp(P0, P3, 0.66)
  const P1 = {
    x: m1.x + n.x * arc * s * rand(0.6, 1),
    y: m1.y + n.y * arc * s * rand(0.6, 1),
  }
  const P2 = {
    x: m2.x + n.x * arc * s * rand(0.6, 1),
    y: m2.y + n.y * arc * s * rand(0.6, 1),
  }
  const steps = clamp(Math.round(d / 12), 12, 40)
  for (let i = 1; i <= steps; i += 1) {
    const p = cubicBezier(P0, P1, P2, P3, easeInOut(i / steps))
    moves.push({ x: Math.round(p.x), y: Math.round(p.y), dt: randInt(8, 20) })
  }
  const u = unit(P0, P3)
  moves.push({
    x: Math.round(clamp(P3.x + u.x * rand(3, 8), 0, w - 1)),
    y: Math.round(clamp(P3.y + u.y * rand(3, 8), 0, h - 1)),
    dt: randInt(20, 50),
  })
  moves.push({ x: P3.x, y: P3.y, dt: 0 })
  return { moves }
}

/** 点击:落点微抖(真人不精确命中同一像素)→ 轨迹 → 悬停 → 按压时序。 */
export function planClick(from: Pt | null, to: Pt, view: View): GesturePlan {
  const jittered = { x: to.x + rand(-3, 3), y: to.y + rand(-3, 3) }
  const plan = planMove(from, jittered, view)
  plan.press = { hoverMs: randInt(40, 160), downMs: randInt(50, 120) }
  return plan
}

/** 拖拽:到起点的轨迹 + 到终点的轨迹(客户端在两段之间夹 down/up)。 */
export function planDrag(
  from: Pt | null,
  start: Pt,
  end: Pt,
  view: View,
): { toStart: Move[]; toEnd: Move[] } {
  return {
    toStart: planMove(from, start, view).moves,
    toEnd: planMove(start, end, view).moves,
  }
}

// ── 键盘节奏(逐字 char 的间隔分布)──
const isPunct = (ch: string): boolean => /[^\p{L}\p{N}\s]/u.test(ch)
function interKeyDelay(ch: string): number {
  let d = randInt(60, 120)
  if (isPunct(ch)) d += randInt(40, 100)
  if (Math.random() < 0.08) d += randInt(150, 350) // 偶尔停顿"想一下"
  return d
}
/** 给一段文本算出每个字符的输入间隔(ms)。 */
export function planType(text: string): { delays: number[] } {
  return { delays: [...text].map((ch) => interKeyDelay(ch)) }
}
