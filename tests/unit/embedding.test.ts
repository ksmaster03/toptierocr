import { describe, it, expect, beforeAll } from 'vitest'

beforeAll(() => {
  process.env.MASTER_KEY_BASE64 = Buffer.from(
    'TEST_TEST_TEST_TEST_TEST_TEST_32',
    'utf-8',
  ).toString('base64')
})

describe('embeddingService (vector helpers)', () => {
  it('cosineSimilarity = 1 for identical vectors', async () => {
    const { embeddingService } = await import('../../src/services/embedding.ts')
    const v = [0.1, 0.2, 0.3, 0.4]
    expect(embeddingService.cosineSimilarity(v, v)).toBeCloseTo(1, 6)
  })

  it('cosineSimilarity = 0 for orthogonal vectors', async () => {
    const { embeddingService } = await import('../../src/services/embedding.ts')
    const a = [1, 0, 0, 0]
    const b = [0, 1, 0, 0]
    expect(embeddingService.cosineSimilarity(a, b)).toBeCloseTo(0, 6)
  })

  it('cosineSimilarity = -1 for opposite vectors', async () => {
    const { embeddingService } = await import('../../src/services/embedding.ts')
    const a = [1, 1, 1]
    const b = [-1, -1, -1]
    expect(embeddingService.cosineSimilarity(a, b)).toBeCloseTo(-1, 6)
  })

  it('cosineSimilarity 0 for empty / mismatched length', async () => {
    const { embeddingService } = await import('../../src/services/embedding.ts')
    expect(embeddingService.cosineSimilarity([], [])).toBe(0)
    expect(embeddingService.cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
  })

  it('cosineSimilarity is similarity, not distance (closer = higher)', async () => {
    const { embeddingService } = await import('../../src/services/embedding.ts')
    const target = [1, 2, 3, 4]
    const close  = [1.1, 2.0, 3.1, 3.9]
    const far    = [-2, 5, 0, -1]
    const simClose = embeddingService.cosineSimilarity(target, close)
    const simFar = embeddingService.cosineSimilarity(target, far)
    expect(simClose).toBeGreaterThan(simFar)
    expect(simClose).toBeGreaterThan(0.99)
  })

  it('encode → decode round-trip', async () => {
    const { embeddingService } = await import('../../src/services/embedding.ts')
    const v = [0.1, -0.2, 0.3, -0.4, 1e-7]
    const json = embeddingService.encode(v)
    expect(typeof json).toBe('string')
    const back = embeddingService.decode(json)
    expect(back).toEqual(v)
  })

  it('decode returns null for invalid / null input', async () => {
    const { embeddingService } = await import('../../src/services/embedding.ts')
    expect(embeddingService.decode(null)).toBeNull()
    expect(embeddingService.decode('')).toBeNull()
    expect(embeddingService.decode('not-json')).toBeNull()
    expect(embeddingService.decode('"not-array"')).toBeNull()
    expect(embeddingService.decode('[1, "two", 3]')).toBeNull()
  })
})
