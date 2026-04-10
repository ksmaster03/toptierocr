import {
  type AIOCRProvider,
  type OCRExtractInput,
  type OCRExtractResult,
  type ProviderInfo,
  type ProviderTier,
  OCRProviderError,
} from './types.ts'
import { INVOICE_PROMPT, extractFieldsFromJson } from './prompt.ts'

const USD_TO_THB = 36
const OPENAI_API = 'https://api.openai.com/v1/chat/completions'

interface OpenAIVariant {
  id: string
  displayName: string
  model: string
  tier: ProviderTier
  inputUsdPer1k: number
  outputUsdPer1k: number
  description: string
}

/**
 * OpenAI Vision provider — supports any OpenAI chat-completion-compatible
 * vision model. Ships with two variants: gpt-4o (premium) and gpt-4o-mini
 * (standard). Both share the same endpoint + JSON response format.
 *
 * Note: OpenAI vision does NOT accept PDF directly via chat completions. For
 * PDFs we transparently mark `supportsPdf: false` so the fallback chain can
 * redirect to a provider that handles PDF.
 */
export class OpenAIOCRProvider implements AIOCRProvider {
  readonly info: ProviderInfo
  private readonly model: string

  constructor(variant: OpenAIVariant) {
    this.model = variant.model
    this.info = {
      id: variant.id,
      displayName: variant.displayName,
      vendor: 'openai',
      tier: variant.tier,
      inputCostPer1k: variant.inputUsdPer1k * USD_TO_THB,
      outputCostPer1k: variant.outputUsdPer1k * USD_TO_THB,
      description: variant.description,
      // PDFs require OpenAI Files API — not supported by this simple path.
      supportsPdf: false,
    }
  }

  async extract(
    input: OCRExtractInput,
    apiKey: string,
  ): Promise<OCRExtractResult> {
    const started = Date.now()

    if (input.mimeType === 'application/pdf') {
      throw new OCRProviderError(
        this.info.id,
        415,
        'OpenAI vision does not accept PDF directly — convert to image or use a PDF-capable provider (Gemini/Claude).',
      )
    }

    const base64 = Buffer.from(input.fileBuffer).toString('base64')
    const dataUrl = `data:${input.mimeType};base64,${base64}`

    const body = {
      model: this.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: INVOICE_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 2048,
    }

    let res: Response
    try {
      res = await fetch(OPENAI_API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
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
        `OpenAI API ${res.status}: ${text.slice(0, 300)}`,
      )
    }

    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }

    const text = payload.choices?.[0]?.message?.content ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new OCRProviderError(
        this.info.id,
        500,
        `OpenAI did not return valid JSON: ${text.slice(0, 200)}`,
        err,
      )
    }

    const inputTokens = payload.usage?.prompt_tokens ?? 0
    const outputTokens = payload.usage?.completion_tokens ?? 0
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

export const GPT_4O_MINI: OpenAIVariant = {
  id: 'gpt-4o-mini',
  displayName: 'OpenAI GPT-4o mini (Vision)',
  model: 'gpt-4o-mini',
  tier: 'standard',
  // GPT-4o mini list: $0.15 / 1M input, $0.60 / 1M output
  inputUsdPer1k: 0.00015,
  outputUsdPer1k: 0.0006,
  description: 'ถูก · เร็ว · เหมาะ fallback · รองรับ image เท่านั้น (ไม่รับ PDF)',
}

export const GPT_4O: OpenAIVariant = {
  id: 'gpt-4o',
  displayName: 'OpenAI GPT-4o (Vision)',
  model: 'gpt-4o',
  tier: 'premium',
  // GPT-4o list: $2.50 / 1M input, $10 / 1M output
  inputUsdPer1k: 0.0025,
  outputUsdPer1k: 0.01,
  description: 'แม่นยำสูง · structured output ดี · รองรับ image เท่านั้น (ไม่รับ PDF)',
}
