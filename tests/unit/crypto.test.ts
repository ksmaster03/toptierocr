import { describe, it, expect, beforeAll } from 'vitest'

// We need MASTER_KEY_BASE64 set before importing src/crypto.ts (it reads env at module load).
// Generate a deterministic 32-byte key for tests so reruns are stable.
beforeAll(() => {
  const key = Buffer.from(
    'TEST_TEST_TEST_TEST_TEST_TEST_32',
    'utf-8',
  )
  process.env.MASTER_KEY_BASE64 = key.toString('base64')
})

describe('crypto (AES-256-GCM master-key envelope)', () => {
  it('encrypts → decrypts a short ASCII secret', async () => {
    const { encryptSecret, decryptSecret } = await import('../../src/crypto.ts')
    const plain = 'AIzaSyExampleApiKey1234567890abcdef'
    const enc = encryptSecret(plain)
    expect(enc.cipherText).toBeTruthy()
    expect(enc.iv).toBeTruthy()
    expect(enc.authTag).toBeTruthy()
    expect(enc.cipherText).not.toContain(plain)
    const decoded = decryptSecret(enc)
    expect(decoded).toBe(plain)
  })

  it('encrypts → decrypts a UTF-8 (Thai) secret', async () => {
    const { encryptSecret, decryptSecret } = await import('../../src/crypto.ts')
    const plain = 'ใบกำกับภาษี-ความลับ-1234'
    const enc = encryptSecret(plain)
    const decoded = decryptSecret(enc)
    expect(decoded).toBe(plain)
  })

  it('produces a different cipherText each call (random IV)', async () => {
    const { encryptSecret } = await import('../../src/crypto.ts')
    const a = encryptSecret('same-input')
    const b = encryptSecret('same-input')
    expect(a.cipherText).not.toBe(b.cipherText)
    expect(a.iv).not.toBe(b.iv)
  })

  it('throws on tampered authTag (GCM integrity check)', async () => {
    const { encryptSecret, decryptSecret } = await import('../../src/crypto.ts')
    const enc = encryptSecret('important-secret')
    const tampered = { ...enc, authTag: Buffer.from('zeros').toString('base64') }
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it('maskSecret hides middle of long string', async () => {
    const { maskSecret } = await import('../../src/crypto.ts')
    expect(maskSecret('AIzaSyDQCUYJ038OAcyLZTBoVXXevef3_9yvb9U')).toBe('AIza…vb9U')
    expect(maskSecret('short')).toBe('****')
  })
})
