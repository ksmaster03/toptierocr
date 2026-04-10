import type { AIOCRProvider, ProviderInfo } from './types.ts'
import { GeminiOCRProvider, GEMINI_FLASH, GEMINI_PRO } from './gemini.ts'
import { ClaudeHaikuOCRProvider } from './claude.ts'
import { OpenAIOCRProvider, GPT_4O_MINI, GPT_4O } from './openai.ts'

/**
 * Single source of truth for "what AI engines does this system support".
 *
 * The Settings dropdown calls `list()` to render options.
 * The OCR service calls `get(id)` to resolve the user's choice.
 *
 * Per-tenant enable/disable lives in the DB (`ai_configs.disabled_providers`);
 * the registry is unaware of tenant state.
 *
 * To add a new provider:
 *   1. Implement AIOCRProvider in providers/ocr/<vendor>.ts
 *   2. Append a `new XxxProvider(...)` to PROVIDERS below.
 * No other file changes.
 */
const PROVIDERS: AIOCRProvider[] = [
  new GeminiOCRProvider(GEMINI_FLASH),
  new GeminiOCRProvider(GEMINI_PRO),
  new ClaudeHaikuOCRProvider(),
  new OpenAIOCRProvider(GPT_4O_MINI),
  new OpenAIOCRProvider(GPT_4O),
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
