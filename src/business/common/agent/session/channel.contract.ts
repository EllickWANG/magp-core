/** 客户端 WS 通道:广播帧 + 「下指令给客户端并等回执」的往返(client_tool_call → client_tool_result)。 */
export const CLIENT_CHANNEL = 'agent:client-channel'

export interface IClientChannel {
  /** 单向广播一帧给会话的全部客户端(assistant_delta / tool_result / result / error 等)。 */
  send(sessionId: string, frame: unknown): void
  /**
   * 下指令给客户端并**等回执** —— 用于浏览器工具:发 client_tool_call,阻塞到客户端回
   * client_tool_result(或取消/超时)。frame 里应含 tool/input;callId 由实现生成并塞进帧。
   */
  request(sessionId: string, frame: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  /** 客户端回 client_tool_result 时由 WsGateway 调用,兑现对应 callId 的等待。 */
  resolveClientTool(callId: string, result: unknown, isError: boolean): void
}
