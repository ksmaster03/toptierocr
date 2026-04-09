import { eq, and } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { batches, invoices, postingLogs, type Invoice } from '../db/schema.ts'
import { batchService } from './batches.ts'

/**
 * Sprint 5 — Submit/post a batch.
 *
 * Targets:
 *   sap-stock | sap-gp | sap-tx  → mock SAP post (generates fake doc numbers)
 *   csv                          → builds a CSV string in memory
 *
 * Modes:
 *   test → no DB status changes, just dry-run validation
 *   real → mark batch.status = 'submitted', record posting_log, "post"
 *
 * Real SAP integration is a Sprint 6+ task. This service produces the same
 * shape of response so the frontend can be wired now.
 */

export type PostingTarget = 'sap-stock' | 'sap-gp' | 'sap-tx' | 'csv'
export type PostingMode = 'test' | 'real'

export interface SubmitInput {
  tenantId: number
  userId: number
  batchId: number
  target: PostingTarget
  mode: PostingMode
}

export interface PostedDoc {
  invoiceId: number
  invoiceNumber: string | null
  vendor: string | null
  account: string | null
  amount: number
  erpDocNo: string | null
  status: 'SUCCESS' | 'ERROR'
  error?: string
}

export interface SubmitResult {
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED'
  batchId: number
  batchName: string
  postedAt: string
  mode: PostingMode
  target: PostingTarget
  documents: PostedDoc[]
  summary: {
    totalDocs: number
    totalAmount: number
    currency: string
    errors: number
  }
  message: string
  csvFilename?: string
  csvBase64?: string
}

function csvEscape(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replaceAll('"', '""') + '"'
  }
  return s
}

function buildCsv(invs: Invoice[]): string {
  const headers = [
    'Invoice No',
    'Vendor',
    'Tax ID',
    'Invoice Date',
    'PO No',
    'GL Code',
    'Cost Center',
    'Subtotal',
    'VAT',
    'Total',
    'Currency',
    'Decision',
    'Review Status',
  ]
  const rows = invs.map((i) => [
    i.invoiceNumber,
    i.vendorName,
    i.vendorTaxId,
    i.invoiceDate,
    i.poNumber,
    i.suggestedGlCode,
    i.suggestedCostCenter,
    i.subtotalAmount,
    i.vatAmount,
    i.totalAmount,
    i.currency ?? 'THB',
    i.matchDecision,
    i.reviewStatus,
  ])
  return [headers, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n')
}

function fakeErpDocNo(idx: number): string {
  // Just deterministic for the demo
  return '5100' + String(10000 + idx).padStart(6, '0')
}

export const submitService = {
  async submit(input: SubmitInput): Promise<SubmitResult> {
    const { tenantId, userId, batchId, target, mode } = input

    const batch = await batchService.getBatch(tenantId, batchId)
    if (!batch) throw new Error('batch not found')

    const allInvs = await batchService.listInvoicesInBatch(tenantId, batchId)
    const approved = allInvs.filter((i) => i.reviewStatus === 'approved')

    if (approved.length === 0) {
      throw new Error('No approved invoices in this batch')
    }

    const totalAmount = approved.reduce(
      (s, i) => s + Number(i.totalAmount ?? 0),
      0,
    )

    // CSV mode — build the CSV, return base64
    if (target === 'csv') {
      const csv = buildCsv(approved)
      const filename = `${batch.name}_${new Date().toISOString().slice(0, 10)}.csv`
      const result: SubmitResult = {
        status: 'SUCCESS',
        batchId,
        batchName: batch.name,
        postedAt: new Date().toISOString(),
        mode,
        target,
        documents: approved.map((i, idx) => ({
          invoiceId: i.id,
          invoiceNumber: i.invoiceNumber,
          vendor: i.vendorName,
          account: i.suggestedGlCode,
          amount: Number(i.totalAmount ?? 0),
          erpDocNo: null,
          status: 'SUCCESS',
        })),
        summary: {
          totalDocs: approved.length,
          totalAmount,
          currency: approved[0]?.currency ?? 'THB',
          errors: 0,
        },
        message: `CSV generated with ${approved.length} rows (${filename})`,
        csvFilename: filename,
        csvBase64: Buffer.from(csv, 'utf-8').toString('base64'),
      }
      if (mode === 'real') {
        await this.recordPosting(tenantId, userId, batchId, target, mode, result)
        await db
          .update(batches)
          .set({ status: 'submitted' })
          .where(and(eq(batches.tenantId, tenantId), eq(batches.id, batchId)))
      }
      return result
    }

    // SAP mock targets — assign fake doc numbers, mark posted
    const docs: PostedDoc[] = approved.map((i, idx) => ({
      invoiceId: i.id,
      invoiceNumber: i.invoiceNumber,
      vendor: i.vendorName,
      account: i.suggestedGlCode,
      amount: Number(i.totalAmount ?? 0),
      erpDocNo: fakeErpDocNo(i.id),
      status: 'SUCCESS',
    }))

    const result: SubmitResult = {
      status: 'SUCCESS',
      batchId,
      batchName: batch.name,
      postedAt: new Date().toISOString(),
      mode,
      target,
      documents: docs,
      summary: {
        totalDocs: docs.length,
        totalAmount,
        currency: approved[0]?.currency ?? 'THB',
        errors: 0,
      },
      message:
        mode === 'real'
          ? `Posted ${docs.length} documents to ${target} successfully`
          : `Test run completed — ${docs.length} documents would be posted to ${target}`,
    }

    if (mode === 'real') {
      await this.recordPosting(tenantId, userId, batchId, target, mode, result)
      await db
        .update(batches)
        .set({ status: 'submitted' })
        .where(and(eq(batches.tenantId, tenantId), eq(batches.id, batchId)))
    }
    return result
  },

  async recordPosting(
    tenantId: number,
    userId: number,
    batchId: number,
    target: string,
    mode: string,
    result: SubmitResult,
  ) {
    await db.insert(postingLogs).values({
      tenantId,
      batchId,
      postedByUserId: userId,
      target,
      mode,
      status: result.status,
      totalDocuments: result.summary.totalDocs,
      totalAmount: String(result.summary.totalAmount),
      responseJson: JSON.stringify(result),
    })
  },

  async listForBatch(tenantId: number, batchId: number) {
    return db
      .select()
      .from(postingLogs)
      .where(and(eq(postingLogs.tenantId, tenantId), eq(postingLogs.batchId, batchId)))
  },
}
