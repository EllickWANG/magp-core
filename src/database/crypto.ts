/**
 * 服务商密钥信封加密 —— 库存密文,主密钥在环境变量 PROVIDER_ENC_KEY。
 * AES-256-GCM;存储格式 base64(iv[12] || tag[16] || ciphertext)。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function masterKey(): Buffer {
  const raw = process.env.PROVIDER_ENC_KEY
  if (!raw) throw new Error('PROVIDER_ENC_KEY 未配置(.env)—— 生成:openssl rand -base64 32')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('PROVIDER_ENC_KEY 必须是 base64 编码的 32 字节')
  return key
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')
}

export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}
