import type { TurnMeta } from '../domain/index.js'

/** 工具执行前的门(映射业务 toolpolicy RBAC)。 */
export const PERMISSION = 'agent:permission'

export type PermissionDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string }

export interface IPermission {
  check(input: {
    tool: string
    args: unknown
    meta: TurnMeta
    signal: AbortSignal
  }): Promise<PermissionDecision>
}
