import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { providerRegistry } from '../providers/ocr/registry.ts'
import { aiConfigService } from '../services/ai-config.ts'
import { authMiddleware, requireRole } from '../auth/middleware.ts'

export const aiConfigRoutes = new Hono()

// All AI config endpoints are admin-only.
aiConfigRoutes.use('*', authMiddleware, requireRole('admin'))

// Resolve tenant from the authenticated user (multi-tenant ready).
const tenantIdOf = (c: Context) => c.get('user').tenantId

/** Drives the dropdown in the Settings UI. Admin-only, returns full list. */
aiConfigRoutes.get('/providers', (c) => {
  return c.json({ providers: providerRegistry.list() })
})

/** Toggle a single provider active/inactive. */
const toggleSchema = z.object({
  providerId: z.string().min(1),
  active: z.boolean(),
})
aiConfigRoutes.put(
  '/providers/toggle',
  zValidator('json', toggleSchema),
  async (c) => {
    const { providerId, active } = c.req.valid('json')
    try {
      const cfg = await aiConfigService.toggleProviderActive(
        tenantIdOf(c),
        providerId,
        active,
      )
      return c.json(cfg)
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : 'toggle failed' },
        400,
      )
    }
  },
)

/** Read current config + which providers have an API key on file. */
aiConfigRoutes.get('/config', async (c) => {
  const cfg = await aiConfigService.getConfig(tenantIdOf(c))
  return c.json(cfg)
})

const updateSchema = z.object({
  ocrProviderId: z.string().min(1).optional(),
  fallbackProviderId: z.string().min(1).nullable().optional(),
  fallbackThreshold: z.number().min(0).max(1).optional(),
  monthlyBudgetThb: z.number().min(0).optional(),
  disabledProviders: z.array(z.string()).optional(),
})

aiConfigRoutes.put(
  '/config',
  zValidator('json', updateSchema),
  async (c) => {
    const patch = c.req.valid('json')
    await aiConfigService.updateConfig(tenantIdOf(c), patch)
    const cfg = await aiConfigService.getConfig(tenantIdOf(c))
    return c.json(cfg)
  },
)

const credSchema = z.object({
  providerId: z.string().min(1),
  apiKey: z.string().min(8),
})

aiConfigRoutes.put(
  '/credentials',
  zValidator('json', credSchema),
  async (c) => {
    const { providerId, apiKey } = c.req.valid('json')
    const { keyHint } = await aiConfigService.saveCredential(
      tenantIdOf(c),
      providerId,
      apiKey,
    )
    return c.json({ ok: true, providerId, keyHint })
  },
)
