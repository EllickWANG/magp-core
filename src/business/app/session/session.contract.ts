/** session 域:会话归属 CRUD + WS 票据。 */
export const SESSION_SERVICE = 'app:session-service'

export interface SessionSummary {
  sessionId: string
  title: string | null
  status: string
  createdAt: Date
}

export interface ISessionService {
  create(userId: string, sessionId: string): Promise<void>
  listByUser(userId: string): Promise<SessionSummary[]>
  isOwner(userId: string, sessionId: string): Promise<boolean>
  delete(userId: string, sessionId: string): Promise<void>
  /** 签发一次性 WS 票据(明文票据返回给客户端,库存 hash)。 */
  issueTicket(userId: string, sessionId: string): Promise<string>
  /** 消费票据(一次性):返回 {userId} 或 null。 */
  consumeTicket(ticket: string): Promise<{ userId: string; sessionId: string } | null>
}
