import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { costSettingsService } from '../services/cost-settings.ts'
import { authMiddleware, requireRole } from '../auth/middleware.ts'

export const costSettingsRoutes = new Hono()

costSettingsRoutes.use('*', authMiddleware)

const tenantIdOf = (c: Context) => c.get('user').tenantId

/** Read — visible to all logged-in users (drives the cost panel in Step 1). */
costSettingsRoutes.get('/', async (c) => {
  const settings = await costSettingsService.get(tenantIdOf(c))
  return c.json(settings)
})

const overrideSchema = z.object({
  inputCostPer1k: z.number().min(0),
  outputCostPer1k: z.number().min(0),
})

const updateSchema = z.object({
  usdToThb: z.number().positive().optional(),
  ocrInputTokensPerPage: z.number().int().min(0).optional(),
  ocrOutputTokensPerPage: z.number().int().min(0).optional(),
  matchingInputTokens: z.number().int().min(0).optional(),
  matchingOutputTokens: z.number().int().min(0).optional(),
  pagesPerFile: z.number().positive().optional(),
  matchingProviderId: z.string().nullable().optional(),
  providerOverrides: z.record(z.string(), overrideSchema).optional(),
})

costSettingsRoutes.put(
  '/',
  requireRole('admin'),
  zValidator('json', updateSchema),
  async (c) => {
    const updated = await costSettingsService.update(
      tenantIdOf(c),
      c.req.valid('json'),
    )
    return c.json(updated)
  },
)
