import type { AIOCRProvider, ProviderInfo } from './types.ts'
import { GeminiOCRProvider } from './gemini.ts'
import { ClaudeHaikuOCRProvider } from './claude.ts'

/**
 * Single source of truth for "what AI engines does this system support".
 *
 * The Settings dropdown calls `list()` to render options.
 * The OCR service calls `get(id)` to resolve the user's choice.
 *
 * To add a new provider:
 *   1. Implement AIOCRProvider in providers/ocr/<vendor>.ts
 *   2. Append a `new XxxProvider()` to PROVIDERS below.
 * No other file changes.
 */
const PROVIDERS: AIOCRProvider[] = [
  new GeminiOCRProvider(),
  new ClaudeHaikuOCRProvider(),
]

const byId = new Map(PROVIDERS.map((p) => [p.info.id, p]))

export const providerRegistry = {
  list(): ProviderInfo[] {
    return PROVIDERS.map((p) => p.info)
  },
  get(id: string): AIOCRProvider | undefined {
    return byId.get(id)
  },
  require(id: string): AIOCRProvider {
    const p = byId.get(id)
    if (!p) throw new Error(`Unknown OCR provider: ${id}`)
    return p
  },
}
