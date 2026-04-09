import { eq, and, sql, asc, desc, count } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { batches, invoices, type Batch, type Invoice } from '../db/schema.ts'
import { storageService } from './storage.ts'

export interface CreateBatchInput {
  tenantId: number
  createdByUserId: number
  files: Array<{
    docTypeCode: string
    originalFilename: string
    mimeType: string
    fileBuffer: Uint8Array
    /** which provider the user picked in the UI radio (optional override) */
    providerRequested?: string
  }>
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0')
}

function todayYmd(d = new Date()): string {
  const y = d.getFullYear()
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${y}${m}${day}`
}

async function nextBatchName(tenantId: number): Promise<string> {
  const ymd = todayYmd()
  const prefix = `BATCH-${ymd}-`
  // Count existing batches today for this tenant
  const rows = await db
    .select({ c: count() })
    .from(batches)
    .where(
      and(
        eq(batches.tenantId, tenantId),
        sql`${batches.name} LIKE ${prefix + '%'}`,
      ),
    )
  const seq = (rows[0]?.c ?? 0) + 1
  return prefix + pad3(seq)
}

export const batchService = {
  /**
   * Create a batch row, persist all files to disk, and create one invoice
   * row per file. Returns the batch with its invoice list.
   */
  async createBatch(input: CreateBatchInput): Promise<{
    batch: Batch
    invoices: Invoice[]
  }> {
    if (input.files.length === 0) {
      throw new Error('No files provided')
    }

    const name = await nextBatchName(input.tenantId)

    // Insert batch
    const [insertResult] = await db.insert(batches).values({
      tenantId: input.tenantId,
      createdByUserId: input.createdByUserId,
      name,
      status: 'uploaded',
      totalFiles: input.files.length,
      totalProcessed: 0,
    })
    const batchId = (insertResult as { insertId: number }).insertId

    const created: Invoice[] = []
    for (const f of input.files) {
      // Insert invoice row first to get its id
      const [r] = await db.insert(invoices).values({
        tenantId: input.tenantId,
        batchId,
        docTypeCode: f.docTypeCode,
        originalFilename: f.originalFilename,
        storagePath: '',  // filled below
        mimeType: f.mimeType,
        fileSizeBytes: f.fileBuffer.length,
        ocrStatus: 'pending',
        ocrProviderRequested: f.providerRequested ?? null,
      })
      const invoiceId = (r as { insertId: number }).insertId

      // Build storage path and write file
      const relativePath = storageService.buildRelativePath({
        tenantId: input.tenantId,
        batchId,
        invoiceId,
        originalFilename: f.originalFilename,
      })
      await storageService.write(relativePath, f.fileBuffer)

      // Persist storage path on the invoice
      await db
        .update(invoices)
        .set({ storagePath: relativePath })
        .where(eq(invoices.id, invoiceId))

      const fresh = await db
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1)
      created.push(fresh[0]!)
    }

    const batchRow = await this.getBatch(input.tenantId, batchId)
    return { batch: batchRow!, invoices: created }
  },

  async getBatch(tenantId: number, id: number): Promise<Batch | null> {
    const rows = await db
      .select()
      .from(batches)
      .where(and(eq(batches.tenantId, tenantId), eq(batches.id, id)))
      .limit(1)
    return rows[0] ?? null
  },

  async listInvoicesInBatch(tenantId: number, batchId: number): Promise<Invoice[]> {
    return db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.batchId, batchId)))
      .orderBy(asc(invoices.id))
  },

  async listRecentBatches(tenantId: number, limit = 20): Promise<Batch[]> {
    return db
      .select()
      .from(batches)
      .where(eq(batches.tenantId, tenantId))
      .orderBy(desc(batches.createdAt))
      .limit(limit)
  },

  async updateBatchStatus(
    tenantId: number,
    id: number,
    patch: { status?: string; totalProcessed?: number; totalCostThb?: number },
  ): Promise<void> {
    const update: Record<string, unknown> = {}
    if (patch.status !== undefined) update.status = patch.status
    if (patch.totalProcessed !== undefined) update.totalProcessed = patch.totalProcessed
    if (patch.totalCostThb !== undefined)
      update.totalCostThb = String(patch.totalCostThb)
    if (Object.keys(update).length === 0) return
    await db
      .update(batches)
      .set(update)
      .where(and(eq(batches.tenantId, tenantId), eq(batches.id, id)))
  },
}
