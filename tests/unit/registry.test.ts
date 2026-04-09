import { describe, it, expect, beforeAll } from 'vitest'

beforeAll(() => {
  process.env.MASTER_KEY_BASE64 = Buffer.from(
    'TEST_TEST_TEST_TEST_TEST_TEST_32',
    'utf-8',
  ).toString('base64')
})

describe('OCR provider registry', () => {
  it('list() returns at least Gemini and Claude providers', async () => {
    const { providerRegistry } = await import('../../src/providers/ocr/registry.ts')
    const list = providerRegistry.list()
    expect(list.length).toBeGreaterThanOrEqual(2)
    const ids = list.map((p) => p.id)
    expect(ids).toContain('gemini-2.5-flash')
    expect(ids).toContain('claude-haiku-4-5')
  })

  it('every provider info has required fields', async () => {
    const { providerRegistry } = await import('../../src/providers/ocr/registry.ts')
    for (const p of providerRegistry.list()) {
      expect(p.id).toBeTruthy()
      expect(p.displayName).toBeTruthy()
      expect(p.vendor).toBeTruthy()
      expect(['free', 'standard', 'premium']).toContain(p.tier)
      expect(typeof p.inputCostPer1k).toBe('number')
      expect(typeof p.outputCostPer1k).toBe('number')
      expect(p.inputCostPer1k).toBeGreaterThanOrEqual(0)
      expect(p.outputCostPer1k).toBeGreaterThanOrEqual(0)
      expect(typeof p.supportsPdf).toBe('boolean')
    }
  })

  it('get(id) resolves a provider', async () => {
    const { providerRegistry } = await import('../../src/providers/ocr/registry.ts')
    const p = providerRegistry.get('gemini-2.5-flash')
    expect(p).toBeDefined()
    expect(p?.info.id).toBe('gemini-2.5-flash')
  })

  it('require(id) throws for unknown provider', async () => {
    const { providerRegistry } = await import('../../src/providers/ocr/registry.ts')
    expect(() => providerRegistry.require('does-not-exist')).toThrow()
  })

  it('Claude is more expensive than Gemini per 1k input tokens', async () => {
    // sanity-check the cost ordering so the registry doesn't quietly drift
    const { providerRegistry } = await import('../../src/providers/ocr/registry.ts')
    const gemini = providerRegistry.require('gemini-2.5-flash').info
    const claude = providerRegistry.require('claude-haiku-4-5').info
    expect(claude.inputCostPer1k).toBeGreaterThan(gemini.inputCostPer1k)
  })
})
