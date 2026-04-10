import {
  type AIOCRProvider,
  type OCRExtractInput,
  type OCRExtractResult,
  type ProviderInfo,
  type ProviderTier,
  OCRProviderError,
} from './types.ts'
import { INVOICE_PROMPT, extractFieldsFromJson } from './prompt.ts'

// Approx FX for cost display. Move to a config table later if you need
// daily-accurate accounting.
const USD_TO_THB = 36

interface GeminiVariant {
  id: string
  displayName: string
  model: string
  tier: ProviderTier
  inputUsdPer1k: number
  outputUsdPer1k: number
  description: string
}

/**
 * Factory: one class, two provider instances (Flash + Pro).
 * Both share the identical HTTP contract — only model + pricing differ.
 */
export class GeminiOCRProvider implements AIOCRProvider {
  readonly info: ProviderInfo
  private readonly model: string

  constructor(variant: GeminiVariant) {
    this.model = variant.model
    this.info = {
      id: variant.id,
      displayName: variant.displayName,
      vendor: 'google',
      tier: variant.tier,
      inputCostPer1k: variant.inputUsdPer1k * USD_TO_THB,
      outputCostPer1k: variant.outputUsdPer1k * USD_TO_THB,
      description: variant.description,
      supportsPdf: true,
    }
  }

  async extract(
    input: OCRExtractInput,
    apiKey: string,
  ): Promise<OCRExtractResult> {
    const started = Date.now()
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${encodeURIComponent(apiKey)}`

    const base64 = Buffer.from(input.fileBuffer).toString('base64')

    const body = {
      contents: [
        {
          parts: [
            { inline_data: { mime_type: input.mimeType, data: base64 } },
            { text: INVOICE_PROMPT },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0,
        maxOutputTokens: 2048,
      },
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (err) {
      throw new OCRProviderError(this.info.id, 0, 'network error', err)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new OCRProviderError(
        this.info.id,
        res.status,
        `Gemini API ${res.status}: ${text.slice(0, 300)}`,
      )
    }

    const payload = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      usageMetadata?: {
        promptTokenCount?: number
        candidatesTokenCount?: number
      }
    }

    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new OCRProviderError(
        this.info.id,
        500,
        `Gemini did not return valid JSON: ${text.slice(0, 200)}`,
        err,
      )
    }

    const inputTokens = payload.usageMetadata?.promptTokenCount ?? 0
    const outputTokens = payload.usageMetadata?.candidatesTokenCount ?? 0
    const costThb =
      (inputTokens / 1000) * this.info.inputCostPer1k +
      (outputTokens / 1000) * this.info.outputCostPer1k

    const { fields, rawText, avgConfidence } = extractFieldsFromJson(parsed)

    return {
      fields,
      rawText,
      rawJson: parsed,
      inputTokens,
      outputTokens,
      costThb,
      latencyMs: Date.now() - started,
      providerUsed: this.info.id,
      avgConfidence,
    }
  }
}

/** Ready-to-use variant constants so the registry can just `new GeminiOCRProvider(GEMINI_FLASH)`. */
export const GEMINI_FLASH: GeminiVariant = {
  id: 'gemini-2.5-flash',
  displayName: 'Google Gemini 2.5 Flash',
  model: 'gemini-2.5-flash',
  tier: 'free',
  inputUsdPer1k: 0.0003,
  outputUsdPer1k: 0.0025,
  description: 'Free 250 req/วัน · มี thinking · ภาษาไทยดีมาก',
}

export const GEMINI_PRO: GeminiVariant = {
  id: 'gemini-2.5-pro',
  displayName: 'Google Gemini 2.5 Pro',
  model: 'gemini-2.5-pro',
  tier: 'premium',
  // 2.5 Pro list: $1.25 / 1M input, $10 / 1M output (Oct 2025)
  inputUsdPer1k: 0.00125,
  outputUsdPer1k: 0.01,
  description: 'แม่นยำสูงสุดของ Google · reasoning ดี · ราคาสูงกว่า Flash',
}
