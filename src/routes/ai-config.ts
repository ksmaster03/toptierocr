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

/** Drives the dropdown in the Settings UI. */
aiConfigRoutes.get('/providers', (c) => {
  return c.json({ providers: providerRegistry.list() })
})

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
