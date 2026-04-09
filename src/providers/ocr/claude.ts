import {
  type AIOCRProvider,
  type OCRExtractInput,
  type OCRExtractResult,
  type ProviderInfo,
  OCRProviderError,
} from './types.ts'
import { INVOICE_PROMPT, extractFieldsFromJson } from './prompt.ts'

const USD_TO_THB = 36

// Claude Haiku 4.5 list price (as of 2025): $1 / 1M input, $5 / 1M output
const INPUT_USD_PER_1K = 0.001
const OUTPUT_USD_PER_1K = 0.005

const INFO: ProviderInfo = {
  id: 'claude-haiku-4-5',
  displayName: 'Claude Haiku 4.5 (Vision)',
  vendor: 'anthropic',
  tier: 'standard',
  inputCostPer1k: INPUT_USD_PER_1K * USD_TO_THB,
  outputCostPer1k: OUTPUT_USD_PER_1K * USD_TO_THB,
  description: 'แม่นยำสูง · ภาษาไทยดี · เหมาะเป็น fallback ของ Gemini',
  supportsPdf: true,
}

const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_VERSION = '2023-06-01'
const CLAUDE_MODEL_ID = 'claude-haiku-4-5'

export class ClaudeHaikuOCRProvider implements AIOCRProvider {
  readonly info = INFO

  async extract(
    input: OCRExtractInput,
    apiKey: string,
  ): Promise<OCRExtractResult> {
    const started = Date.now()

    // Anthropic supports image/png, image/jpeg, image/webp, image/gif and
    // application/pdf as document blocks. We branch on mimeType.
    const isPdf = input.mimeType === 'application/pdf'
    const base64 = Buffer.from(input.fileBuffer).toString('base64')

    const mediaBlock = isPdf
      ? {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: base64,
          },
        }
      : {
          type: 'image',
          source: {
            type: 'base64',
            media_type: input.mimeType,
            data: base64,
          },
        }

    const body = {
      model: CLAUDE_MODEL_ID,
      max_tokens: 2048,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [mediaBlock, { type: 'text', text: INVOICE_PROMPT }],
        },
      ],
    }

    let res: Response
    try {
      res = await fetch(CLAUDE_API, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': CLAUDE_VERSION,
        },
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
        `Claude API ${res.status}: ${text.slice(0, 300)}`,
      )
    }

    const payload = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>
      usage?: { input_tokens?: number; output_tokens?: number }
    }

    const text =
      payload.content?.find((c) => c.type === 'text')?.text?.trim() ?? ''

    // Claude sometimes wraps JSON in ```json fences if it gets chatty.
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')

    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch (err) {
      throw new OCRProviderError(
        INFO.id,
        500,
        `Claude did not return valid JSON: ${cleaned.slice(0, 200)}`,
        err,
      )
    }

    const inputTokens = payload.usage?.input_tokens ?? 0
    const outputTokens = payload.usage?.output_tokens ?? 0
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
