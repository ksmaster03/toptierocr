import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { vendorMasterService } from '../services/vendors.ts'
import { authMiddleware, requireRole } from '../auth/middleware.ts'

export const purchaseOrderRoutes = new Hono()

purchaseOrderRoutes.use('*', authMiddleware)

const tenantIdOf = (c: Context) => c.get('user').tenantId

purchaseOrderRoutes.get('/', async (c) => {
  const list = await vendorMasterService.listPos(tenantIdOf(c))
  return c.json({ pos: list })
})

const createSchema = z.object({
  poNo: z.string().min(1).max(64),
  vendorId: z.number().int().positive().nullable().optional(),
  vendorNameSnapshot: z.string().max(255).nullable().optional(),
  totalAmount: z.number().nonnegative().nullable().optional(),
  currency: z.string().max(8).optional(),
  description: z.string().max(2000).nullable().optional(),
})

purchaseOrderRoutes.post(
  '/',
  requireRole('admin'),
  zValidator('json', createSchema),
  async (c) => {
    const created = await vendorMasterService.createPo({
      tenantId: tenantIdOf(c),
      ...c.req.valid('json'),
    })
    return c.json({ po: created }, 201)
  },
)
