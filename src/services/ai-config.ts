import { eq, and } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { aiConfigs, apiCredentials } from '../db/schema.ts'
import { encryptSecret, decryptSecret, maskSecret } from '../crypto.ts'
import { providerRegistry } from '../providers/ocr/registry.ts'

export interface PublicAiConfig {
  ocrProviderId: string
  fallbackProviderId: string | null
  fallbackThreshold: number
  monthlyBudgetThb: number
  hasCredentialFor: Record<string, boolean>
}

export const aiConfigService = {
  async getConfig(tenantId: number): Promise<PublicAiConfig> {
    const rows = await db
      .select()
      .from(aiConfigs)
      .where(eq(aiConfigs.tenantId, tenantId))
      .limit(1)

    const cfg = rows[0]
    if (!cfg) {
      throw new Error(`No AI config for tenant ${tenantId}. Run db:seed.`)
    }

    const creds = await db
      .select({ provider: apiCredentials.provider })
      .from(apiCredentials)
      .where(eq(apiCredentials.tenantId, tenantId))

    const hasCredentialFor = Object.fromEntries(
      providerRegistry.list().map((p) => [
        p.id,
        creds.some((c) => c.provider === p.id),
      ]),
    )

    return {
      ocrProviderId: cfg.ocrProviderId,
      fallbackProviderId: cfg.fallbackProviderId,
      fallbackThreshold: Number(cfg.fallbackThreshold),
      monthlyBudgetThb: Number(cfg.monthlyBudgetThb),
      hasCredentialFor,
    }
  },

  async updateConfig(
    tenantId: number,
    patch: {
      ocrProviderId?: string
      fallbackProviderId?: string | null
      fallbackThreshold?: number
      monthlyBudgetThb?: number
    },
  ) {
    if (patch.ocrProviderId && !providerRegistry.get(patch.ocrProviderId)) {
      throw new Error(`Unknown ocrProviderId: ${patch.ocrProviderId}`)
    }
    if (
      patch.fallbackProviderId &&
      !providerRegistry.get(patch.fallbackProviderId)
    ) {
      throw new Error(`Unknown fallbackProviderId: ${patch.fallbackProviderId}`)
    }

    const update: Record<string, unknown> = {}
    if (patch.ocrProviderId !== undefined) update.ocrProviderId = patch.ocrProviderId
    if (patch.fallbackProviderId !== undefined)
      update.fallbackProviderId = patch.fallbackProviderId
    if (patch.fallbackThreshold !== undefined)
      update.fallbackThreshold = String(patch.fallbackThreshold)
    if (patch.monthlyBudgetThb !== undefined)
      update.monthlyBudgetThb = String(patch.monthlyBudgetThb)

    if (Object.keys(update).length === 0) return

    await db
      .update(aiConfigs)
      .set(update)
      .where(eq(aiConfigs.tenantId, tenantId))
  },

  /** Save / overwrite an API key for one provider, encrypted with master key. */
  async saveCredential(
    tenantId: number,
    providerId: string,
    apiKey: string,
  ): Promise<{ keyHint: string }> {
    if (!providerRegistry.get(providerId)) {
      throw new Error(`Unknown providerId: ${providerId}`)
    }
    if (!apiKey || apiKey.length < 8) {
      throw new Error('API key looks too short')
    }

    const enc = encryptSecret(apiKey)
    const keyHint = maskSecret(apiKey)

    // upsert per (tenant, provider)
    const existing = await db
      .select({ id: apiCredentials.id })
      .from(apiCredentials)
      .where(
        and(
          eq(apiCredentials.tenantId, tenantId),
          eq(apiCredentials.provider, providerId),
        ),
      )
      .limit(1)

    if (existing[0]) {
      await db
        .update(apiCredentials)
        .set({
          cipherText: enc.cipherText,
          iv: enc.iv,
          authTag: enc.authTag,
          keyHint,
        })
        .where(eq(apiCredentials.id, existing[0].id))
    } else {
      await db.insert(apiCredentials).values({
        tenantId,
        provider: providerId,
        cipherText: enc.cipherText,
        iv: enc.iv,
        authTag: enc.authTag,
        keyHint,
      })
    }
    return { keyHint }
  },

  /** Internal: load + decrypt a key for runtime use. Never expose plaintext to HTTP. */
  async loadDecryptedKey(
    tenantId: number,
    providerId: string,
  ): Promise<string | null> {
    const rows = await db
      .select()
      .from(apiCredentials)
      .where(
        and(
          eq(apiCredentials.tenantId, tenantId),
          eq(apiCredentials.provider, providerId),
        ),
      )
      .limit(1)

    const row = rows[0]
    if (!row) return null

    return decryptSecret({
      cipherText: row.cipherText,
      iv: row.iv,
      authTag: row.authTag,
    })
  },
}
