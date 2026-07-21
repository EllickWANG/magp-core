/**
 * 会话转录落 PG/SQLite 的底层读写(通用设施,业务与 agent 共用)。
 * (sessionId, seq) 主键即幂等键,重复上报撞主键静默跳过(skipDuplicates)。
 * 注:SessionEvent 有 FK 到 AgentSession,写入前该会话行须存在(由会话业务创建)。
 */
import { getPrisma } from '../../database/prisma.js'

export interface SessionEventLine {
  seq: number
  line: string
}

export async function appendSessionEvents(sessionId: string, events: SessionEventLine[]): Promise<void> {
  if (events.length === 0) return
  const prisma = getPrisma()
  // SQLite 的 createMany 不支持 skipDuplicates;用 upsert 事务实现 (sessionId,seq) 幂等:
  // 已存在则 update:{}(不动),等价 INSERT OR IGNORE,重复上报静默跳过。
  await prisma.$transaction(
    events.map((e) =>
      prisma.sessionEvent.upsert({
        where: { sessionId_seq: { sessionId, seq: e.seq } },
        create: { sessionId, seq: e.seq, line: e.line },
        update: {},
      }),
    ),
  )
}

export async function listSessionEvents(sessionId: string): Promise<SessionEventLine[]> {
  const rows = await getPrisma().sessionEvent.findMany({
    where: { sessionId },
    orderBy: { seq: 'asc' },
    select: { seq: true, line: true },
  })
  return rows
}

export async function maxSessionEventSeq(sessionId: string): Promise<number> {
  const agg = await getPrisma().sessionEvent.aggregate({
    where: { sessionId },
    _max: { seq: true },
  })
  return agg._max.seq ?? 0
}
