import { eq } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { costSettings } from '../db/schema.ts'
import { providerRegistry } from '../providers/ocr/registry.ts'

/**
 * Per-tenant cost estimation parameters and provider price overrides.
 *
 * Source of truth for the "ประเมินค่าใช้จ่าย" panel and the admin master
 * page. Provider-cost overrides let the admin keep estimation accurate as
 * vendor pricing changes — no code redeploy needed.
 */
export interface ProviderCostOverride {
  inputCostPer1k: number
  outputCostPer1k: number
}

export interface PublicCostSettings {
  usdToThb: number
  ocrInputTokensPerPage: number
  ocrOutputTokensPerPage: number
  matchingInputTokens: number
  matchingOutputTokens: number
  pagesPerFile: number
  matchingProviderId: string | null
  providerOverrides: Record<string, ProviderCostOverride>
  /** Resolved (override OR registry default) costs per provider — what the UI should show. */
  effectiveCosts: Record<string, ProviderCostOverride & { source: 'override' | 'default' }>
}

function parseOverrides(raw: string | null): Record<string, ProviderCostOverride> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, ProviderCostOverride>
  } catch {
    return {}
  }
}

function buildEffective(
  overrides: Record<string, ProviderCostOverride>,
): PublicCostSettings['effectiveCosts'] {
  const out: PublicCostSettings['effectiveCosts'] = {}
  for (const p of providerRegistry.list()) {
    const ov = overrides[p.id]
    if (ov && Number.isFinite(ov.inputCostPer1k) && Number.isFinite(ov.outputCostPer1k)) {
      out[p.id] = { ...ov, source: 'override' }
    } else {
      out[p.id] = {
        inputCostPer1k: p.inputCostPer1k,
        outputCostPer1k: p.outputCostPer1k,
        source: 'default',
      }
    }
  }
  return out
}

export const costSettingsService = {
  async get(tenantId: number): Promise<PublicCostSettings> {
    const rows = await db
      .select()
      .from(costSettings)
      .where(eq(costSettings.tenantId, tenantId))
      .limit(1)

    let row = rows[0]
    if (!row) {
      // auto-create defaults if missing
      await db.insert(costSettings).values({ tenantId })
      const after = await db
        .select()
        .from(costSettings)
        .where(eq(costSettings.tenantId, tenantId))
        .limit(1)
      row = after[0]!
    }

    const overrides = parseOverrides(row.providerOverrides)

    return {
      usdToThb: Number(row.usdToThb),
      ocrInputTokensPerPage: row.ocrInputTokensPerPage,
      ocrOutputTokensPerPage: row.ocrOutputTokensPerPage,
      matchingInputTokens: row.matchingInputTokens,
      matchingOutputTokens: row.matchingOutputTokens,
      pagesPerFile: Number(row.pagesPerFile),
      matchingProviderId: row.matchingProviderId,
      providerOverrides: overrides,
      effectiveCosts: buildEffective(overrides),
    }
  },

  async update(
    tenantId: number,
    patch: Partial<{
      usdToThb: number
      ocrInputTokensPerPage: number
      ocrOutputTokensPerPage: number
      matchingInputTokens: number
      matchingOutputTokens: number
      pagesPerFile: number
      matchingProviderId: string | null
      providerOverrides: Record<string, ProviderCostOverride>
    }>,
  ): Promise<PublicCostSettings> {
    // ensure row exists
    await this.get(tenantId)

    const update: Record<string, unknown> = {}
    if (patch.usdToThb !== undefined) update.usdToThb = String(patch.usdToThb)
    if (patch.ocrInputTokensPerPage !== undefined)
      update.ocrInputTokensPerPage = patch.ocrInputTokensPerPage
    if (patch.ocrOutputTokensPerPage !== undefined)
      update.ocrOutputTokensPerPage = patch.ocrOutputTokensPerPage
    if (patch.matchingInputTokens !== undefined)
      update.matchingInputTokens = patch.matchingInputTokens
    if (patch.matchingOutputTokens !== undefined)
      update.matchingOutputTokens = patch.matchingOutputTokens
    if (patch.pagesPerFile !== undefined)
      update.pagesPerFile = String(patch.pagesPerFile)
    if (patch.matchingProviderId !== undefined)
      update.matchingProviderId = patch.matchingProviderId
    if (patch.providerOverrides !== undefined)
      update.providerOverrides = JSON.stringify(patch.providerOverrides)

    if (Object.keys(update).length > 0) {
      await db
        .update(costSettings)
        .set(update)
        .where(eq(costSettings.tenantId, tenantId))
    }

    return this.get(tenantId)
  },
}
