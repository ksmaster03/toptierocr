import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { eq, and, inArray } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { invoices } from '../db/schema.ts'
import { invoiceService } from '../services/invoices.ts'
import { authMiddleware } from '../auth/middleware.ts'

export const invoiceRoutes = new Hono()

invoiceRoutes.use('*', authMiddleware)

const tenantIdOf = (c: Context) => c.get('user').tenantId
const userIdOf = (c: Context) => c.get('user').id

invoiceRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
  const inv = await invoiceService.getInvoice(tenantIdOf(c), id)
  if (!inv) return c.json({ error: 'not found' }, 404)
  const lines = await invoiceService.getInvoiceLines(id)
  return c.json({ invoice: inv, lines })
})

/**
 * Stream the original uploaded file. Used by Step 2 preview pane.
 */
invoiceRoutes.get('/:id/file', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
  const inv = await invoiceService.getInvoice(tenantIdOf(c), id)
  if (!inv) return c.json({ error: 'not found' }, 404)
  try {
    const buffer = await invoiceService.readInvoiceFile(inv)
    return c.body(buffer, 200, {
      'content-type': inv.mimeType,
      'content-disposition': `inline; filename="${encodeURIComponent(inv.originalFilename)}"`,
      'cache-control': 'private, max-age=300',
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'read failed'
    return c.json({ error: msg }, 500)
  }
})

/**
 * Sprint 4 — set review status on an invoice.
 */
const reviewSchema = z.object({
  status: z.enum(['pending', 'approved', 'hold', 'rejected']),
  note: z.string().max(2000).nullable().optional(),
  glCode: z.string().max(64).nullable().optional(),
  costCenter: z.string().max(64).nullable().optional(),
})

invoiceRoutes.put(
  '/:id/review',
  zValidator('json', reviewSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
    const tid = tenantIdOf(c)
    const patch = c.req.valid('json')

    const update: Record<string, unknown> = {
      reviewStatus: patch.status,
      reviewedByUserId: userIdOf(c),
      reviewedAt: new Date(),
    }
    if (patch.note !== undefined) update.reviewNote = patch.note
    if (patch.glCode !== undefined) update.suggestedGlCode = patch.glCode
    if (patch.costCenter !== undefined) update.suggestedCostCenter = patch.costCenter

    await db
      .update(invoices)
      .set(update)
      .where(and(eq(invoices.tenantId, tid), eq(invoices.id, id)))

    const inv = await invoiceService.getInvoice(tid, id)
    return c.json({ invoice: inv })
  },
)

/**
 * Sprint 4 — bulk review action.
 * Body: { ids: number[], status: 'approved'|'hold'|'rejected' }
 */
const bulkReviewSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
  status: z.enum(['pending', 'approved', 'hold', 'rejected']),
})

invoiceRoutes.put(
  '/bulk-review',
  zValidator('json', bulkReviewSchema),
  async (c) => {
    const tid = tenantIdOf(c)
    const { ids, status } = c.req.valid('json')
    await db
      .update(invoices)
      .set({
        reviewStatus: status,
        reviewedByUserId: userIdOf(c),
        reviewedAt: new Date(),
      })
      .where(and(eq(invoices.tenantId, tid), inArray(invoices.id, ids)))
    return c.json({ ok: true, updated: ids.length })
  },
)

/**
 * Re-run OCR on a single invoice. Useful for retry after a failure.
 */
invoiceRoutes.post('/:id/ocr', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
  try {
    const updated = await invoiceService.runOcrOn(tenantIdOf(c), id)
    return c.json({ invoice: updated })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'ocr failed' },
      500,
    )
  }
})
