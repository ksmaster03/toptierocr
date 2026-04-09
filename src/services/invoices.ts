import { eq, and } from 'drizzle-orm'
import { db } from '../db/client.ts'
import {
  invoices,
  invoiceLines,
  type Invoice,
  type InvoiceLine,
} from '../db/schema.ts'
import { storageService } from './storage.ts'
import { ocrService } from './ocr.ts'

/**
 * Map an OCR field key (from prompt schema) to its denormalized column on
 * `invoices`. Anything not in this map stays in `ocr_raw_json`.
 */
const FIELD_COLUMN_MAP: Record<string, keyof typeof invoices.$inferInsert> = {
  vendor_name: 'vendorName',
  vendor_tax_id: 'vendorTaxId',
  invoice_number: 'invoiceNumber',
  invoice_date: 'invoiceDate',
  po_number: 'poNumber',
  currency: 'currency',
  payment_terms: 'paymentTerms',
}

const NUMERIC_FIELD_COLUMN_MAP: Record<string, keyof typeof invoices.$inferInsert> = {
  subtotal: 'subtotalAmount',
  vat_amount: 'vatAmount',
  total_amount: 'totalAmount',
}

function parseNumber(value: string): number | null {
  if (!value) return null
  const cleaned = value.replace(/[^\d.\-]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

export const invoiceService = {
  async getInvoice(tenantId: number, id: number): Promise<Invoice | null> {
    const rows = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, id)))
      .limit(1)
    return rows[0] ?? null
  },

  async getInvoiceLines(invoiceId: number): Promise<InvoiceLine[]> {
    return db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoiceId))
  },

  async readInvoiceFile(invoice: Invoice): Promise<Buffer> {
    return storageService.read(invoice.storagePath)
  },

  /**
   * Run OCR on a single invoice. Persists status, raw JSON, denormalized
   * fields, line items, and cost. Returns the updated invoice row.
   */
  async runOcrOn(tenantId: number, invoiceId: number): Promise<Invoice> {
    const inv = await this.getInvoice(tenantId, invoiceId)
    if (!inv) throw new Error(`Invoice ${invoiceId} not found`)

    // mark as processing so concurrent calls don't double-process
    await db
      .update(invoices)
      .set({ ocrStatus: 'processing', ocrError: null })
      .where(eq(invoices.id, invoiceId))

    let buffer: Buffer
    try {
      buffer = await this.readInvoiceFile(inv)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'storage read failed'
      await db
        .update(invoices)
        .set({ ocrStatus: 'failed', ocrError: msg })
        .where(eq(invoices.id, invoiceId))
      throw e
    }

    try {
      const result = await ocrService.run({
        tenantId,
        fileBuffer: new Uint8Array(buffer),
        mimeType: inv.mimeType,
        providerOverride: inv.ocrProviderRequested ?? undefined,
      })

      // Build update patch from extracted fields
      const update: Record<string, unknown> = {
        ocrStatus: 'done',
        ocrProviderUsed: result.providerUsed,
        ocrAvgConfidence: result.avgConfidence.toFixed(4),
        ocrInputTokens: result.inputTokens,
        ocrOutputTokens: result.outputTokens,
        ocrCostThb: result.costThb.toFixed(6),
        ocrLatencyMs: result.latencyMs,
        ocrRawJson: JSON.stringify(result.rawJson),
        ocrError: null,
        ocrAt: new Date(),
      }

      for (const f of result.fields) {
        const strCol = FIELD_COLUMN_MAP[f.key]
        if (strCol) {
          update[strCol] = f.value || null
          continue
        }
        const numCol = NUMERIC_FIELD_COLUMN_MAP[f.key]
        if (numCol) {
          const n = parseNumber(f.value)
          update[numCol] = n != null ? String(n) : null
        }
      }

      await db.update(invoices).set(update).where(eq(invoices.id, invoiceId))

      // Persist line items if present
      const raw = result.rawJson as
        | { line_items?: Array<{ description?: string; quantity?: number; unit_price?: number; amount?: number }> }
        | undefined
      const lines = raw?.line_items
      if (Array.isArray(lines) && lines.length > 0) {
        // Replace any existing line items (idempotent re-processing)
        await db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId))
        let lineNo = 1
        for (const li of lines) {
          await db.insert(invoiceLines).values({
            invoiceId,
            lineNo: lineNo++,
            description: li.description ?? null,
            quantity: li.quantity != null ? String(li.quantity) : null,
            unitPrice: li.unit_price != null ? String(li.unit_price) : null,
            amount: li.amount != null ? String(li.amount) : null,
          })
        }
      }

      return (await this.getInvoice(tenantId, invoiceId))!
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await db
        .update(invoices)
        .set({ ocrStatus: 'failed', ocrError: msg })
        .where(eq(invoices.id, invoiceId))
      throw e
    }
  },
}
