import {
  type AIOCRProvider,
  type OCRExtractInput,
  type OCRExtractResult,
  type ProviderInfo,
  OCRProviderError,
} from './types.ts'
import { INVOICE_PROMPT, extractFieldsFromJson } from './prompt.ts'

// Approx FX for cost display. Move to a config table later if you need
// daily-accurate accounting.
const USD_TO_THB = 36

// Gemini 2.5 Flash list price (as of 2025-11): $0.30 / 1M input, $2.50 / 1M output
// (gemini-2.0-flash free tier was discontinued; 2.5-flash is the current
// free tier model with 250 RPD on the free tier.)
const INPUT_USD_PER_1K = 0.0003
const OUTPUT_USD_PER_1K = 0.0025
const MODEL = 'gemini-2.5-flash'

const INFO: ProviderInfo = {
  id: 'gemini-2.5-flash',
  displayName: 'Google Gemini 2.5 Flash',
  vendor: 'google',
  tier: 'free',
  inputCostPer1k: INPUT_USD_PER_1K * USD_TO_THB,
  outputCostPer1k: OUTPUT_USD_PER_1K * USD_TO_THB,
  description: 'Free 250 req/วัน · มี thinking · ภาษาไทยดีมาก',
  supportsPdf: true,
}

export class GeminiOCRProvider implements AIOCRProvider {
  readonly info = INFO

  async extract(
    input: OCRExtractInput,
    apiKey: string,
  ): Promise<OCRExtractResult> {
    const started = Date.now()
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`

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
      throw new OCRProviderError(INFO.id, 0, 'network error', err)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new OCRProviderError(
        INFO.id,
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
        INFO.id,
        500,
        `Gemini did not return valid JSON: ${text.slice(0, 200)}`,
        err,
      )
    }

    const inputTokens = payload.usageMetadata?.promptTokenCount ?? 0
    const outputTokens = payload.usageMetadata?.candidatesTokenCount ?? 0
    const costThb =
      (inputTokens / 1000) * INFO.inputCostPer1k +
      (outputTokens / 1000) * INFO.outputCostPer1k

    const { fields, rawText, avgConfidence } = extractFieldsFromJson(parsed)

    return {
      fields,
      rawText,
      rawJson: parsed,
      inputTokens,
      outputTokens,
      costThb,
      latencyMs: Date.now() - started,
      providerUsed: INFO.id,
      avgConfidence,
    }
  }
}
