/**
 * Provider-agnostic OCR contract.
 *
 * Every AI OCR backend (Gemini, Claude, OpenAI, Mistral, …) implements this
 * single interface. The rest of the system never imports a concrete provider —
 * it asks the registry for one by id.
 */

export type ProviderTier = 'free' | 'standard' | 'premium'

export interface OCRField {
  /** machine key, e.g. "vendor_name" */
  key: string
  /** extracted value as string (caller may post-parse to number/date) */
  value: string
  /** 0..1 model-reported confidence */
  confidence: number
}

export interface OCRExtractInput {
  fileBuffer: Uint8Array
  /** image/png, image/jpeg, application/pdf */
  mimeType: string
  language?: 'th' | 'en' | 'auto'
}

export interface OCRExtractResult {
  fields: OCRField[]
  rawText: string
  rawJson: unknown
  inputTokens: number
  outputTokens: number
  costThb: number
  latencyMs: number
  providerUsed: string
  avgConfidence: number
}

export interface ProviderInfo {
  id: string
  displayName: string
  vendor: 'google' | 'anthropic' | 'openai' | 'mistral' | 'other'
  tier: ProviderTier
  /** THB per 1k input tokens */
  inputCostPer1k: number
  /** THB per 1k output tokens */
  outputCostPer1k: number
  /** UI-facing one-liner */
  description: string
  supportsPdf: boolean
}

export interface AIOCRProvider {
  readonly info: ProviderInfo
  extract(input: OCRExtractInput, apiKey: string): Promise<OCRExtractResult>
}

export class OCRProviderError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly status: number,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${providerId}] ${message}`)
    this.name = 'OCRProviderError'
  }
}
