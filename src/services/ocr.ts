import { db } from '../db/client.ts'
import { aiUsageLog } from '../db/schema.ts'
import { providerRegistry } from '../providers/ocr/registry.ts'
import type { OCRExtractResult } from '../providers/ocr/types.ts'
import { aiConfigService } from './ai-config.ts'

export interface RunOcrInput {
  tenantId: number
  fileBuffer: Uint8Array
  mimeType: string
  /** override the tenant's configured provider (e.g. when user picks from dropdown) */
  providerOverride?: string
}

export interface RunOcrOutput extends OCRExtractResult {
  fellBackFrom?: string
}

export const ocrService = {
  /**
   * Resolve provider → load credential → call provider → log usage.
   * If the result confidence falls below the configured threshold AND a
   * fallback provider is configured AND the credential is present, retry
   * with the fallback (once).
   */
  async run(input: RunOcrInput): Promise<RunOcrOutput> {
    const cfg = await aiConfigService.getConfig(input.tenantId)
    const primaryId = input.providerOverride ?? cfg.ocrProviderId

    const result = await this.runOne(input.tenantId, primaryId, input)

    const shouldFallback =
      !input.providerOverride &&
      cfg.fallbackProviderId &&
      cfg.fallbackProviderId !== primaryId &&
      cfg.hasCredentialFor[cfg.fallbackProviderId] === true &&
      result.avgConfidence < cfg.fallbackThreshold

    if (shouldFallback && cfg.fallbackProviderId) {
      const fb = await this.runOne(
        input.tenantId,
        cfg.fallbackProviderId,
        input,
        primaryId,
      )
      // prefer fallback only if it actually beats primary
      if (fb.avgConfidence > result.avgConfidence) {
        return { ...fb, fellBackFrom: primaryId }
      }
    }

    return result
  },

  async runOne(
    tenantId: number,
    providerId: string,
    input: RunOcrInput,
    fallbackFrom?: string,
  ): Promise<OCRExtractResult> {
    const provider = providerRegistry.require(providerId)

    // Reject if admin has disabled this provider
    const active = await aiConfigService.isProviderActive(tenantId, providerId)
    if (!active) {
      throw new Error(
        `Provider "${providerId}" is inactive for this tenant. ` +
          'Activate it in Admin → AI Provider settings.',
      )
    }

    const apiKey = await aiConfigService.loadDecryptedKey(tenantId, providerId)
    if (!apiKey) {
      throw new Error(
        `No API key configured for provider "${providerId}". ` +
          'Save one via PUT /api/ai/credentials.',
      )
    }

    const result = await provider.extract(
      {
        fileBuffer: input.fileBuffer,
        mimeType: input.mimeType,
      },
      apiKey,
    )

    await db.insert(aiUsageLog).values({
      tenantId,
      provider: providerId,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costThb: result.costThb.toFixed(4),
      latencyMs: result.latencyMs,
      fallbackFrom: fallbackFrom ?? null,
    })

    return result
  },
}
