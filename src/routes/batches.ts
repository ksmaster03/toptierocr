import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { batchService } from '../services/batches.ts'
import { invoiceService } from '../services/invoices.ts'
import { matchingService } from '../services/matching.ts'
import { submitService } from '../services/submit.ts'
import { authMiddleware, requireRole } from '../auth/middleware.ts'

export const batchRoutes = new Hono()

batchRoutes.use('*', authMiddleware)

const tenantIdOf = (c: Context) => c.get('user').tenantId
const userIdOf = (c: Context) => c.get('user').id

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
])

const MAX_BYTES = 20 * 1024 * 1024 // 20 MB
const MAX_FILES = 100

/**
 * POST /api/batches
 *
 * multipart/form-data:
 *   files[]:    binary x N
 *   types[]:    document type code, parallel array (one per file)
 *   provider:   (optional) ocr provider id chosen via Step 1 radio
 */
batchRoutes.post('/', async (c) => {
  const form = await c.req.formData().catch(() => null)
  if (!form) return c.json({ error: 'expected multipart/form-data' }, 400)

  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  const types = form.getAll('types').map(String)
  const provider = (form.get('provider') as string | null) || undefined

  if (files.length === 0) {
    return c.json({ error: 'no files provided' }, 400)
  }
  if (files.length > MAX_FILES) {
    return c.json({ error: `too many files (max ${MAX_FILES})` }, 400)
  }
  if (types.length !== files.length) {
    return c.json(
      { error: `types[] count (${types.length}) must match files[] count (${files.length})` },
      400,
    )
  }

  const fileInputs = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!
    if (!ALLOWED_MIME.has(f.type)) {
      return c.json({ error: `unsupported mime: ${f.type} (${f.name})` }, 415)
    }
    if (f.size > MAX_BYTES) {
      return c.json({ error: `file too large: ${f.name}` }, 413)
    }
    const buf = new Uint8Array(await f.arrayBuffer())
    fileInputs.push({
      docTypeCode: types[i] || '',
      originalFilename: f.name,
      mimeType: f.type,
      fileBuffer: buf,
      providerRequested: provider,
    })
  }

  const { batch, invoices: created } = await batchService.createBatch({
    tenantId: tenantIdOf(c),
    createdByUserId: userIdOf(c),
    files: fileInputs,
  })

  return c.json({ batch, invoices: created }, 201)
})

batchRoutes.get('/', async (c) => {
  const list = await batchService.listRecentBatches(tenantIdOf(c))
  return c.json({ batches: list })
})

batchRoutes.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
  const batch = await batchService.getBatch(tenantIdOf(c), id)
  if (!batch) return c.json({ error: 'not found' }, 404)
  const invs = await batchService.listInvoicesInBatch(tenantIdOf(c), id)
  return c.json({ batch, invoices: invs })
})

/**
 * Run OCR sequentially on every pending invoice in the batch.
 * Returns a summary; for each invoice the up-to-date row.
 */
batchRoutes.post('/:id/process', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)

  const tid = tenantIdOf(c)
  const batch = await batchService.getBatch(tid, id)
  if (!batch) return c.json({ error: 'not found' }, 404)

  await batchService.updateBatchStatus(tid, id, { status: 'processing' })

  const all = await batchService.listInvoicesInBatch(tid, id)
  const pending = all.filter((i) => i.ocrStatus === 'pending' || i.ocrStatus === 'failed')

  let processedDelta = 0
  let totalCost = Number(batch.totalCostThb ?? 0)
  const results: Array<{ invoiceId: number; status: string; error?: string }> = []

  // Free tier of Gemini 2.5 Flash is 10 RPM = 1 call per 6s. Wait 7s between
  // calls to stay under the limit with margin. This makes a 10-file batch
  // take ~70s which is acceptable for MVP.
  const RATE_LIMIT_DELAY_MS = 7000

  for (let idx = 0; idx < pending.length; idx++) {
    const inv = pending[idx]!
    try {
      const updated = await invoiceService.runOcrOn(tid, inv.id)
      processedDelta++
      totalCost += Number(updated.ocrCostThb ?? 0)
      results.push({ invoiceId: inv.id, status: 'done' })
    } catch (e) {
      results.push({
        invoiceId: inv.id,
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
      })
    }
    // delay before next iteration (skip after the last one)
    if (idx < pending.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS))
    }
  }

  const newTotal = batch.totalProcessed + processedDelta
  const allDone = newTotal === batch.totalFiles
  await batchService.updateBatchStatus(tid, id, {
    status: allDone ? 'reviewing' : 'processing',
    totalProcessed: newTotal,
    totalCostThb: totalCost,
  })

  const fresh = await batchService.getBatch(tid, id)
  const freshInvoices = await batchService.listInvoicesInBatch(tid, id)
  return c.json({ batch: fresh, invoices: freshInvoices, results })
})

/**
 * Sprint 3 — run AI Matching on every OCR-done invoice in the batch.
 * Embeds vendor + doc signatures, scans master vendors + POs, decides
 * AUTO_POST / REVIEW / EXCEPTION, persists results.
 */
batchRoutes.post('/:id/match', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
  const tid = tenantIdOf(c)

  const batch = await batchService.getBatch(tid, id)
  if (!batch) return c.json({ error: 'not found' }, 404)

  try {
    const results = await matchingService.runMatchOnBatch(tid, id)
    await batchService.updateBatchStatus(tid, id, { status: 'reviewing' })
    const fresh = await batchService.getBatch(tid, id)
    const freshInvoices = await batchService.listInvoicesInBatch(tid, id)
    return c.json({ batch: fresh, invoices: freshInvoices, results })
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : 'matching failed' },
      500,
    )
  }
})

/**
 * Sprint 5 — submit / post a batch.
 * Body: { target: 'sap-stock'|'sap-gp'|'sap-tx'|'csv', mode: 'test'|'real' }
 *
 * Real-mode posting is restricted to admin users (demo cannot post to ERP).
 */
const submitSchema = z.object({
  target: z.enum(['sap-stock', 'sap-gp', 'sap-tx', 'csv']),
  mode: z.enum(['test', 'real']),
})

batchRoutes.post(
  '/:id/submit',
  zValidator('json', submitSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)

    const user = c.get('user')
    const { target, mode } = c.req.valid('json')

    // Real posting is admin-only
    if (mode === 'real' && user.role !== 'admin') {
      return c.json({ error: 'forbidden: real posting requires admin' }, 403)
    }

    try {
      const result = await submitService.submit({
        tenantId: user.tenantId,
        userId: user.id,
        batchId: id,
        target,
        mode,
      })
      return c.json(result)
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : 'submit failed' },
        500,
      )
    }
  },
)

batchRoutes.get('/:id/postings', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: 'bad id' }, 400)
  const list = await submitService.listForBatch(tenantIdOf(c), id)
  return c.json({ postings: list })
})
