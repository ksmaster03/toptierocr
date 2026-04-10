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
  /** Provider IDs the admin has disabled for this tenant. */
  disabledProviders: string[]
  /** Convenience: enabled === !disabled */
  activeProviders: Record<string, boolean>
}

function parseDisabled(raw: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
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

    const disabledProviders = parseDisabled(cfg.disabledProviders)
    const activeProviders = Object.fromEntries(
      providerRegistry.list().map((p) => [p.id, !disabledProviders.includes(p.id)]),
    )

    return {
      ocrProviderId: cfg.ocrProviderId,
      fallbackProviderId: cfg.fallbackProviderId,
      fallbackThreshold: Number(cfg.fallbackThreshold),
      monthlyBudgetThb: Number(cfg.monthlyBudgetThb),
      hasCredentialFor,
      disabledProviders,
      activeProviders,
    }
  },

  async isProviderActive(tenantId: number, providerId: string): Promise<boolean> {
    const cfg = await this.getConfig(tenantId)
    return cfg.activeProviders[providerId] === true
  },

  async updateConfig(
    tenantId: number,
    patch: {
      ocrProviderId?: string
      fallbackProviderId?: string | null
      fallbackThreshold?: number
      monthlyBudgetThb?: number
      disabledProviders?: string[]
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
    if (patch.disabledProviders) {
      for (const id of patch.disabledProviders) {
        if (!providerRegistry.get(id)) {
          throw new Error(`Unknown provider in disabledProviders: ${id}`)
        }
      }
    }

    const update: Record<string, unknown> = {}
    if (patch.ocrProviderId !== undefined) update.ocrProviderId = patch.ocrProviderId
    if (patch.fallbackProviderId !== undefined)
      update.fallbackProviderId = patch.fallbackProviderId
    if (patch.fallbackThreshold !== undefined)
      update.fallbackThreshold = String(patch.fallbackThreshold)
    if (patch.monthlyBudgetThb !== undefined)
      update.monthlyBudgetThb = String(patch.monthlyBudgetThb)
    if (patch.disabledProviders !== undefined)
      update.disabledProviders = JSON.stringify(patch.disabledProviders)

    if (Object.keys(update).length === 0) return

    await db
      .update(aiConfigs)
      .set(update)
      .where(eq(aiConfigs.tenantId, tenantId))
  },

  /**
   * Toggle a single provider's active state. Refuses to disable a provider
   * that is currently the primary (ocrProviderId) or fallback.
   */
  async toggleProviderActive(
    tenantId: number,
    providerId: string,
    active: boolean,
  ): Promise<PublicAiConfig> {
    if (!providerRegistry.get(providerId)) {
      throw new Error(`Unknown provider: ${providerId}`)
    }
    const cfg = await this.getConfig(tenantId)
    if (!active && (cfg.ocrProviderId === providerId || cfg.fallbackProviderId === providerId)) {
      throw new Error(
        `Cannot disable "${providerId}" — it is currently set as the primary or fallback. Switch to another provider first.`,
      )
    }
    const set = new Set(cfg.disabledProviders)
    if (active) set.delete(providerId)
    else set.add(providerId)
    await this.updateConfig(tenantId, { disabledProviders: [...set] })
    return this.getConfig(tenantId)
  },

  /**
   * Save / overwrite an API key for one provider, encrypted with master key.
   *
   * Uses atomic UPDATE-then-INSERT to avoid the race window where two
   * concurrent saves both SELECT empty and both INSERT, hitting the
   * (tenant_id, provider) unique constraint with ER_DUP_ENTRY.
   */
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

    // Try UPDATE first — works for both first save (0 rows) and overwrite.
    const updateResult = await db
      .update(apiCredentials)
      .set({
        cipherText: enc.cipherText,
        iv: enc.iv,
        authTag: enc.authTag,
        keyHint,
      })
      .where(
        and(
          eq(apiCredentials.tenantId, tenantId),
          eq(apiCredentials.provider, providerId),
        ),
      )

    // Drizzle returns mysql2's OkPacket as the first element of the result
    const affectedRows =
      (updateResult as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0

    if (affectedRows === 0) {
      // No existing row → INSERT. If a concurrent request beat us to it
      // (race), the unique constraint will throw — catch and ignore because
      // the other request already wrote a valid row for this (tenant, provider).
      try {
        await db.insert(apiCredentials).values({
          tenantId,
          provider: providerId,
          cipherText: enc.cipherText,
          iv: enc.iv,
          authTag: enc.authTag,
          keyHint,
        })
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code !== 'ER_DUP_ENTRY') throw err
        // Lost the race — overwrite the winner with our value
        await db
          .update(apiCredentials)
          .set({
            cipherText: enc.cipherText,
            iv: enc.iv,
            authTag: enc.authTag,
            keyHint,
          })
          .where(
            and(
              eq(apiCredentials.tenantId, tenantId),
              eq(apiCredentials.provider, providerId),
            ),
          )
      }
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
