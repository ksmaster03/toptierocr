import { describe, it, expect, beforeAll } from 'vitest'

beforeAll(() => {
  process.env.MASTER_KEY_BASE64 = Buffer.from(
    'TEST_TEST_TEST_TEST_TEST_TEST_32',
    'utf-8',
  ).toString('base64')
})

describe('OCR provider registry', () => {
  it('list() returns all 5 providers (2 Gemini + 1 Claude + 2 OpenAI)', async () => {
    const { providerRegistry } = await import('../../src/providers/ocr/registry.ts')
    const list = providerRegistry.list()
    expect(list.length).toBe(5)
    const ids = list.map((p) => p.id)
    expect(ids).toContain('gemini-2.5-flash')
    expect(ids).toContain('gemini-2.5-pro')
    expect(ids).toContain('claude-haiku-4-5')
    expect(ids).toContain('gpt-4o-mini')
    expect(ids).toContain('gpt-4o')
  })

  it('OpenAI providers report supportsPdf=false', async () => {
    const { providerRegistry } = await import('../../src/providers/ocr/registry.ts')
    expect(providerRegistry.require('gpt-4o').info.supportsPdf).toBe(false)
    expect(providerRegistry.require('gpt-4o-mini').info.supportsPdf).toBe(false)
    // Gemini + Claude accept PDF natively
    expect(providerRegistry.require('gemini-2.5-flash').info.supportsPdf).toBe(true)
    expect(providerRegistry.require('claude-haiku-4-5').info.supportsPdf).toBe(true)
  })

  it('tiers are assigned correctly', async () => {
    const { providerRegistry } = await import('../../src/providers/ocr/registry.ts')
    expect(providerRegistry.require('gemini-2.5-flash').info.tier).toBe('free')
    expect(providerRegistry.require('gemini-2.5-pro').info.tier).toBe('premium')
    expect(providerRegistry.require('gpt-4o').info.tier).toBe('premium')
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
