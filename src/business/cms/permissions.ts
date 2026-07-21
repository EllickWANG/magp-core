/**
 * 权限点注册表 —— **代码是真相源,库只是投影**。
 *
 * 角色表里存的是"勾了哪几个 key",key 本身在这里声明。这样加一个权限点只用改这个文件,
 * 不用写迁移;而库里万一存了个已经不存在的 key(改名/删掉),校验时会被剔掉,不会静默生效。
 */
export type PermissionDef = { key: string; name: string; group: string }

export const PERMISSIONS: readonly PermissionDef[] = [
  { key: 'user.read', name: '查看用户', group: '用户' },
  { key: 'user.manage', name: '管理用户(停用/角色指派)', group: '用户' },
  { key: 'plan.read', name: '查看套餐', group: '套餐' },
  { key: 'plan.manage', name: '编辑套餐', group: '套餐' },
  { key: 'provider.read', name: '查看服务商', group: '服务商' },
  { key: 'provider.manage', name: '编辑/指派服务商', group: '服务商' },
  { key: 'provider.reveal', name: '查看服务商密钥', group: '服务商' },
  { key: 'provider.test', name: '探活服务商', group: '服务商' },
  { key: 'usage.read', name: '查看用量', group: '运营' },
  { key: 'audit.read', name: '查看审计日志', group: '运营' },
  { key: 'build.read', name: '查看客户端构建', group: '客户端' },
  { key: 'build.manage', name: '审批客户端构建', group: '客户端' },
  { key: 'toolpolicy.read', name: '查看工具策略', group: '工具策略' },
  { key: 'toolpolicy.manage', name: '编辑工具策略', group: '工具策略' },
  { key: 'rbac.read', name: '查看角色', group: '权限' },
  { key: 'rbac.manage', name: '管理角色与权限', group: '权限' },
]

const KEYS = new Set(PERMISSIONS.map((p) => p.key))

/** 把外部传来的权限点数组洗成合法子集(去重、剔掉不认识的 key)。 */
export function sanitizePermissionKeys(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return [...new Set(input.filter((k): k is string => typeof k === 'string' && KEYS.has(k)))]
}

export function parsePermissions(json: string | null): string[] {
  try {
    return sanitizePermissionKeys(JSON.parse(json ?? '[]'))
  } catch {
    return []
  }
}
