import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { vendorMasterService } from '../services/vendors.ts'
import { authMiddleware, requireRole } from '../auth/middleware.ts'

export const vendorRoutes = new Hono()

vendorRoutes.use('*', authMiddleware)

const tenantIdOf = (c: Context) => c.get('user').tenantId

vendorRoutes.get('/', async (c) => {
  const list = await vendorMasterService.listVendors(tenantIdOf(c))
  return c.json({ vendors: list })
})

const createSchema = z.object({
  name: z.string().min(1).max(255),
  taxId: z.string().max(64).nullable().optional(),
  sapCode: z.string().max(64).nullable().optional(),
  category: z.string().max(64).nullable().optional(),
})

vendorRoutes.post(
  '/',
  requireRole('admin'),
  zValidator('json', createSchema),
  async (c) => {
    const created = await vendorMasterService.createVendor({
      tenantId: tenantIdOf(c),
      ...c.req.valid('json'),
    })
    return c.json({ vendor: created }, 201)
  },
)
