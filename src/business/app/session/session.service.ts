import { Inject, Provide, Scope, ScopeEnum } from '@midwayjs/core'
import { createHash, randomBytes } from 'node:crypto'
import { PRISMA, PrismaService } from '../../../database/prisma.service.js'
import {
  SESSION_SERVICE,
  type ISessionService,
  type SessionSummary,
} from './session.contract.js'

const TICKET_TTL_MS = 60_000
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

@Provide(SESSION_SERVICE)
@Scope(ScopeEnum.Singleton)
export class SessionService implements ISessionService {
  @Inject(PRISMA) private readonly db!: PrismaService

  async create(userId: string, sessionId: string): Promise<void> {
    await this.db.client.agentSession.upsert({
      where: { sessionId },
      create: { sessionId, ownerUserId: userId },
      update: { lastActiveAt: new Date() },
    })
  }

  async listByUser(userId: string): Promise<SessionSummary[]> {
    return this.db.client.agentSession.findMany({
      where: { ownerUserId: userId },
      orderBy: { createdAt: 'desc' },
      select: { sessionId: true, title: true, status: true, createdAt: true },
    })
  }

  async isOwner(userId: string, sessionId: string): Promise<boolean> {
    const s = await this.db.client.agentSession.findUnique({ where: { sessionId }, select: { ownerUserId: true } })
    return s?.ownerUserId === userId
  }

  async delete(userId: string, sessionId: string): Promise<void> {
    await this.db.client.agentSession.deleteMany({ where: { sessionId, ownerUserId: userId } })
  }

  async issueTicket(userId: string, sessionId: string): Promise<string> {
    const ticket = randomBytes(32).toString('base64url')
    await this.db.client.wsTicket.create({
      data: { ticketHash: sha256(ticket), sessionId, userId, expiresAt: new Date(Date.now() + TICKET_TTL_MS) },
    })
    return ticket
  }

  async consumeTicket(ticket: string): Promise<{ userId: string; sessionId: string } | null> {
    const hash = sha256(ticket)
    const rows = await this.db.client.wsTicket.findUnique({ where: { ticketHash: hash } })
    if (!rows) return null
    await this.db.client.wsTicket.delete({ where: { ticketHash: hash } }) // 一次性
    if (rows.expiresAt.getTime() < Date.now()) return null
    return { userId: rows.userId, sessionId: rows.sessionId }
  }
}
