/**
 * 端点 URL 拼装 —— 处理「baseUrl 到底带不带版本段」这个经典坑。
 *
 * 现实里两种写法都有人填:
 *   https://nexus.ftcagent.cn/v1     (带 /v1 —— OpenAI SDK 的习惯,Magp 现有配置就是这种)
 *   https://api.anthropic.com        (不带 —— 各家官方文档的写法)
 *
 * 硬拼 `${base}/v1/messages` 会把第一种拼成 `/v1/v1/messages`(404);
 * 硬拼 `${base}/messages` 又会把第二种拼成缺版本段(404)。两种都见过,而且报错都是 404,
 * 让人以为是"模型不存在"去改模型名 —— 越改越错。所以这里**自动探测**:
 * base 末尾已有版本段(/v1、/v3、/api/paas/v4 …)就直接接路径,否则补 /v1。
 */
const VERSION_TAIL = /\/v\d+[a-z]*$/i

export function apiUrl(baseURL: string, versionlessPath: string): string {
  const base = baseURL.trim().replace(/\/+$/, '')
  const path = versionlessPath.startsWith('/') ? versionlessPath : `/${versionlessPath}`
  return VERSION_TAIL.test(base) ? `${base}${path}` : `${base}/v1${path}`
}

/** 给 OpenAI SDK 用的 baseURL:它自己会追加**不带版本**的路径,所以必须保证 base 带版本段。 */
export function openaiBaseURL(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, '')
  return VERSION_TAIL.test(base) ? base : `${base}/v1`
}
