/**
 * 浏览器风控闸门 —— **服务端权威版**(从旧 control-plane guard.service.ts 移植)。
 *
 * 为什么在服务端:
 *  1. **IP 保护**:拟人停留的分布、冷却/预算的规则,是"看起来像人在慢慢逛"的核心 know-how,
 *     不该躺在客户端 asar 里被解包白拿 —— 搬到服务端后用户设备上一行都没有。
 *  2. **权威**:客户端能被篡改。硬频控(每小时/每天上限)放服务端算,篡改客户端也绕不过 ——
 *     防的是有人改客户端把自己的号刷废、连累整个服务。
 *
 * 客户端只做一件没 IP 的事:收到 `{ ok, delayMs }` 后 sleep(delayMs)。**决策全在这。**
 *
 * ## 和旧版的区别:单进程 → 内存态,不上 PG
 *
 * 旧版跑在多副本 swarm 上,状态落 PG + per-bucket 咨询锁串行并发副本。core 是**单进程**,
 * 状态按 (userId, identityId) 分桶存进程内存 Map 即可 —— 同进程天然串行,不需要锁,也不需要 PG。
 * 代价:进程重启后当天预算清零(旧版持久)。对反检测来说可接受:重启本身就罕见,且预算是"别太密"
 * 的软约束,不是账本。算法(分布/阈值/上限)与旧版逐字一致。
 */

export type Decision = { ok: true; delayMs: number } | { ok: false; error: string }

// ── 拟人随机停留(对数正态,Box–Muller)—— 核心 IP ──
const DWELL = {
  costly: { medianMs: 7000, sigma: 0.6, minMs: 2500, maxMs: 45000 },
  local: { medianMs: 1200, sigma: 0.5, minMs: 500, maxMs: 5000 },
} as const

function sampleDwellMs(kind: 'costly' | 'local'): number {
  const { medianMs, sigma, minMs, maxMs } = DWELL[kind]
  const u1 = Math.random() || 1e-9
  const u2 = Math.random()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  const value = medianMs * Math.exp(sigma * z)
  return Math.round(Math.min(maxMs, Math.max(minMs, value)))
}

// ── 微休息:连着触达 11~15 次后插一段 30~90s 长停顿(按桶) ──
const MICRO_BREAK_MIN_MS = 30_000
const MICRO_BREAK_MAX_MS = 90_000
function newBreakThreshold(): number {
  return 11 + Math.floor(Math.random() * 5)
}

// ── 撞墙冷却(按桶) ──
const BLOCK_COOLDOWN_MS = 5 * 60 * 1000

// ── 滚动窗口预算(按桶) ──
const ROLLING_HOUR_CAP = 40
const ROLLING_DAY_CAP = 300
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const DAY_BUDGET_MSG = `这个身份 24 小时内的浏览器请求已达上限(${ROLLING_DAY_CAP} 次)。为规避风控已暂停,请明天再继续,或换一个走独立网络的身份。`
const HOUR_BUDGET_MSG = `这个身份一小时内的浏览器请求偏密(${ROLLING_HOUR_CAP} 次)。已暂停,请过一会儿再继续。`

// ── 进程内状态(按桶) ──
const cooldownUntil = new Map<string, number>() // bucket → 冷却截止 ms
const budgetEvents = new Map<string, number[]>() // bucket → 触达时间戳(升序)
const breakState = new Map<string, { count: number; threshold: number }>()

/**
 * 预算 + 微休息(同步、毫秒级,单进程天然串行):
 * 清出滚动窗外的时间戳 → 判日/时上限 → 通过才记账 → 推进微休息计数。
 * 返回 [错误文案|null, 追加的微休息毫秒]。
 */
function budgetAndBreak(bucket: string): [string | null, number] {
  const now = Date.now()
  const kept = (budgetEvents.get(bucket) ?? []).filter((ts) => ts >= now - DAY_MS)
  if (kept.length >= ROLLING_DAY_CAP) {
    budgetEvents.set(bucket, kept)
    return [DAY_BUDGET_MSG, 0]
  }
  const hour = kept.reduce((acc, ts) => (ts > now - HOUR_MS ? acc + 1 : acc), 0)
  if (hour >= ROLLING_HOUR_CAP) {
    budgetEvents.set(bucket, kept)
    return [HOUR_BUDGET_MSG, 0]
  }
  kept.push(now)
  budgetEvents.set(bucket, kept)

  const st = breakState.get(bucket)
  const threshold = st?.threshold ?? newBreakThreshold()
  const count = (st?.count ?? 0) + 1
  const dueBreak = count >= threshold
  breakState.set(bucket, {
    count: dueBreak ? 0 : count,
    threshold: dueBreak ? newBreakThreshold() : threshold,
  })
  const breakMs = dueBreak
    ? MICRO_BREAK_MIN_MS + Math.floor(Math.random() * (MICRO_BREAK_MAX_MS - MICRO_BREAK_MIN_MS))
    : 0
  return [null, breakMs]
}

/**
 * 触达动作前的决策。返回 delayMs 让客户端去 sleep(等待没 IP,决策在这)。
 * costly=false(纯本地/读取)只给轻量停留,不计预算、不受冷却。
 */
export function beforeAction(userId: string, identityId: string, costly: boolean): Decision {
  const key = `${userId}:${identityId}`
  let delayMs = sampleDwellMs(costly ? 'costly' : 'local')
  if (costly) {
    const until = cooldownUntil.get(key) ?? 0
    const cdMs = until - Date.now()
    if (cdMs > 0) {
      return {
        ok: false,
        error: `这个身份刚触发了平台风控,正在冷却(约剩 ${Math.ceil(cdMs / 1000)} 秒)。冷却期请勿重试或翻页 —— 硬闯会加深封禁。可以先读取已打开的页面(读取零风险),或换个身份。`,
      }
    }
    const [budgetErr, breakMs] = budgetAndBreak(key)
    if (budgetErr) return { ok: false, error: budgetErr }
    delayMs += breakMs
  }
  return { ok: true, delayMs }
}

/** 读到风控/验证页时调:让这个身份冷却 5 分钟。 */
export function markBlocked(userId: string, identityId: string): void {
  cooldownUntil.set(`${userId}:${identityId}`, Date.now() + BLOCK_COOLDOWN_MS)
}

// ── 风控页识别 ──
//
// "怎么认出淘宝在拦你/把你踢到登录页"的规则(文案/URL/登录页特征)= know-how,
// 放服务端后客户端只发页面文本+URL,规则不在 asar 里。
const RISK_TEXT_RE =
  /访问太频繁|请稍后重试|滑动验证|拖动滑块|请输入验证码|安全验证|访问被拒绝|异常流量|你的网络存在异常|人机验证|滑块以完成验证/
const RISK_URL_RE = /(punish|nocaptcha|_____tmd_____)/i

/**
 * 判定一页是不是风控/验证/登录页(读到它的数据是垃圾,agent 别继续翻)。
 * text = 页面标题+可见文本(客户端截前 3000 字);url = location.href。
 */
export function riskCheck(text: string, url: string): boolean {
  if (RISK_TEXT_RE.test(text)) return true
  if (RISK_URL_RE.test(url)) return true
  try {
    const u = new URL(url)
    if (/^(login|passport|auth|signin|account)\./i.test(u.hostname)) return true
    if (/(^|\/)(login|signin|sign_in)(\b|\.|\/)/i.test(u.pathname)) return true
  } catch {
    /* url 解析失败 → 不据此判风控 */
  }
  return false
}
