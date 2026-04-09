import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from './env.ts'

// AES-256-GCM envelope encryption for tenant API credentials.
// The master key never leaves env / Secrets Manager. The DB only stores
// (cipherText, iv, authTag). Losing the master key = losing all stored keys.

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32

function loadMasterKey(): Buffer {
  const key = Buffer.from(env.MASTER_KEY_BASE64, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `MASTER_KEY_BASE64 must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
      'Generate with: bun -e "console.log(crypto.getRandomValues(new Uint8Array(32)).toBuffer().toString(\'base64\'))"'
    )
  }
  return key
}

const masterKey = loadMasterKey()

export interface Encrypted {
  cipherText: string  // base64
  iv: string          // base64
  authTag: string     // base64
}

export function encryptSecret(plaintext: string): Encrypted {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, masterKey, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    cipherText: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: tag.toString('base64'),
  }
}

export function decryptSecret(payload: Encrypted): string {
  const iv = Buffer.from(payload.iv, 'base64')
  const tag = Buffer.from(payload.authTag, 'base64')
  const ct = Buffer.from(payload.cipherText, 'base64')
  const decipher = createDecipheriv(ALGO, masterKey, iv)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}

/** One-way preview for showing keys in the UI without revealing them. */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return '****'
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`
}
