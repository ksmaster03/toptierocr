import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { documentTypeService } from '../services/document-types.ts'
import { authMiddleware, requireRole } from '../auth/middleware.ts'

export const documentTypeRoutes = new Hono()

documentTypeRoutes.use('*', authMiddleware)

const tenantIdOf = (c: Context) => c.get('user').tenantId

/** Public to all logged-in users — drives Step 1 dropdown. */
documentTypeRoutes.get('/', async (c) => {
  const types = await documentTypeService.listActive(tenantIdOf(c))
  return c.json({ types })
})

/** Admin: list ALL including inactive. */
documentTypeRoutes.get('/all', requireRole('admin'), async (c) => {
  const types = await documentTypeService.listAll(tenantIdOf(c))
  return c.json({ types })
})

const createSchema = z.object({
  code: z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/, 'lowercase, digits, _-'),
  name: z.string().min(1).max(128),
  description: z.string().max(2000).optional().nullable(),
  icon: z.string().max(64).optional(),
  monthlyVolumeLabel: z.string().max(64).optional().nullable(),
  flowDescription: z.string().max(2000).optional().nullable(),
  outputTarget: z.string().max(64).optional().nullable(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
})

documentTypeRoutes.post(
  '/',
  requireRole('admin'),
  zValidator('json', createSchema),
  async (c) => {
    try {
      const created = await documentTypeService.create({
        tenantId: tenantIdOf(c),
        ...c.req.valid('json'),
      })
      return c.json({ type: created }, 201)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown'
      return c.json({ error: msg }, 400)
    }
  },
)

const updateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(2000).optional().nullable(),
  icon: z.string().max(64).optional(),
  monthlyVolumeLabel: z.string().max(64).optional().nullable(),
  flowDescription: z.string().max(2000).optional().nullable(),
  outputTarget: z.string().max(64).optional().nullable(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  active: z.number().int().min(0).max(1).optional(),
})

documentTypeRoutes.put(
  '/:id',
  requireRole('admin'),
  zValidator('json', updateSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
    const updated = await documentTypeService.update(
      tenantIdOf(c),
      id,
      c.req.valid('json'),
    )
    if (!updated) return c.json({ error: 'not found' }, 404)
    return c.json({ type: updated })
  },
)

documentTypeRoutes.delete('/:id', requireRole('admin'), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
  await documentTypeService.softDelete(tenantIdOf(c), id)
  return c.json({ ok: true })
})
