import { eq, and } from 'drizzle-orm'
import { db } from '../db/client.ts'
import {
  invoices,
  vendors,
  purchaseOrders,
  type Invoice,
  type Vendor,
  type PurchaseOrder,
} from '../db/schema.ts'
import { embeddingService } from './embedding.ts'

/**
 * AI Matching service for Sprint 3.
 *
 * Pipeline per invoice:
 *   1. Build a "vendor signature" string (vendor_name + tax_id) → embed
 *   2. Build a "doc signature"  string (vendor + total + line items) → embed
 *   3. Cosine-similarity scan vendors[] in this tenant → top match
 *   4. Look up PO by exact po_number first; if missing, try fuzzy
 *      cosine-similarity scan over PO.description_embedding
 *   5. Decide:
 *        - vendor sim ≥ 0.85 AND (po match OR tax_id matches) → AUTO_POST
 *        - vendor sim 0.70..0.85 OR amount mismatch        → REVIEW
 *        - vendor sim < 0.70 OR no PO at all              → EXCEPTION
 *   6. Persist matched_vendor_id, matched_po_id, scores, decision, reasoning,
 *      embeddings (so we don't re-embed on retry)
 *
 * GL code suggestion: copied from the matched PO's vendor.category if any,
 * otherwise left null. (LLM-based GL suggestion is a Sprint-4+ extension.)
 */

export interface MatchResult {
  invoiceId: number
  decision: 'AUTO_POST' | 'REVIEW' | 'EXCEPTION'
  vendorId: number | null
  vendorScore: number
  poId: number | null
  poScore: number
  reasoning: string
}

const AUTO_POST_THRESHOLD = 0.85
const REVIEW_THRESHOLD = 0.70

function buildVendorSignature(inv: Invoice): string {
  const parts = [inv.vendorName, inv.vendorTaxId].filter(Boolean)
  return parts.join(' | ')
}

function buildDocSignature(inv: Invoice, lineDescriptions: string[] = []): string {
  const parts = [
    inv.vendorName,
    inv.invoiceNumber,
    inv.poNumber,
    inv.totalAmount ? `total=${inv.totalAmount}` : null,
    ...lineDescriptions.slice(0, 10),
  ].filter(Boolean)
  return parts.join(' | ')
}

async function findBestVendor(
  tenantId: number,
  invVendorEmbedding: number[],
): Promise<{ vendor: Vendor; score: number } | null> {
  const all = await db
    .select()
    .from(vendors)
    .where(and(eq(vendors.tenantId, tenantId), eq(vendors.active, 1)))

  let best: { vendor: Vendor; score: number } | null = null
  for (const v of all) {
    const vec = embeddingService.decode(v.embedding)
    if (!vec) continue
    const sim = embeddingService.cosineSimilarity(invVendorEmbedding, vec)
    if (!best || sim > best.score) {
      best = { vendor: v, score: sim }
    }
  }
  return best
}

async function findBestPO(
  tenantId: number,
  invPoNumber: string | null,
  invDocEmbedding: number[],
): Promise<{ po: PurchaseOrder; score: number; matchType: 'exact' | 'fuzzy' } | null> {
  // 1. Exact po_no match wins outright
  if (invPoNumber) {
    const exact = await db
      .select()
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.tenantId, tenantId),
          eq(purchaseOrders.poNo, invPoNumber),
        ),
      )
      .limit(1)
    if (exact[0]) {
      return { po: exact[0], score: 1.0, matchType: 'exact' }
    }
  }

  // 2. Fuzzy cosine over description_embedding
  const all = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.tenantId, tenantId))

  let best: { po: PurchaseOrder; score: number; matchType: 'fuzzy' } | null = null
  for (const po of all) {
    const vec = embeddingService.decode(po.descriptionEmbedding)
    if (!vec) continue
    const sim = embeddingService.cosineSimilarity(invDocEmbedding, vec)
    if (!best || sim > best.score) {
      best = { po, score: sim, matchType: 'fuzzy' }
    }
  }
  return best
}

function decideMatch(
  invoice: Invoice,
  vendorMatch: { vendor: Vendor; score: number } | null,
  poMatch: { po: PurchaseOrder; score: number; matchType: 'exact' | 'fuzzy' } | null,
): { decision: 'AUTO_POST' | 'REVIEW' | 'EXCEPTION'; reasoning: string } {
  const reasons: string[] = []

  // Vendor reasoning
  if (vendorMatch) {
    const pct = (vendorMatch.score * 100).toFixed(0)
    reasons.push(
      `Vendor "${invoice.vendorName ?? '?'}" → "${vendorMatch.vendor.name}" (similarity ${pct}%)`,
    )
    if (
      invoice.vendorTaxId &&
      vendorMatch.vendor.taxId &&
      invoice.vendorTaxId === vendorMatch.vendor.taxId
    ) {
      reasons.push('Tax ID match: ✓')
    } else if (invoice.vendorTaxId && vendorMatch.vendor.taxId) {
      reasons.push(`Tax ID mismatch (invoice=${invoice.vendorTaxId}, master=${vendorMatch.vendor.taxId})`)
    }
  } else {
    reasons.push('⚠ Vendor not found in master')
  }

  // PO reasoning
  if (poMatch) {
    const pct = (poMatch.score * 100).toFixed(0)
    if (poMatch.matchType === 'exact') {
      reasons.push(`PO ${poMatch.po.poNo} matched exactly by number`)
    } else {
      reasons.push(`PO ${poMatch.po.poNo} matched fuzzily (similarity ${pct}%)`)
    }
    if (invoice.totalAmount && poMatch.po.totalAmount) {
      const diff = Math.abs(Number(invoice.totalAmount) - Number(poMatch.po.totalAmount))
      const tol = Math.max(1, Number(poMatch.po.totalAmount) * 0.01)
      if (diff <= tol) {
        reasons.push(`Amount match: invoice ${invoice.totalAmount} ≈ PO ${poMatch.po.totalAmount}`)
      } else {
        reasons.push(`Amount mismatch: invoice ${invoice.totalAmount} vs PO ${poMatch.po.totalAmount}`)
      }
    }
  } else {
    reasons.push('⚠ No matching PO found')
  }

  // Decision matrix
  const vScore = vendorMatch?.score ?? 0
  const hasPo = !!poMatch
  const taxIdMatches =
    !!invoice.vendorTaxId &&
    !!vendorMatch?.vendor.taxId &&
    invoice.vendorTaxId === vendorMatch.vendor.taxId

  let decision: 'AUTO_POST' | 'REVIEW' | 'EXCEPTION'
  if (vScore >= AUTO_POST_THRESHOLD && hasPo) {
    decision = 'AUTO_POST'
  } else if (vScore >= AUTO_POST_THRESHOLD && taxIdMatches) {
    decision = 'AUTO_POST'
  } else if (vScore >= REVIEW_THRESHOLD || hasPo) {
    decision = 'REVIEW'
  } else {
    decision = 'EXCEPTION'
  }

  return {
    decision,
    reasoning: '[AI Matching] ' + reasons.join(' · '),
  }
}

export const matchingService = {
  /** Embed + match a single invoice. Persists results. */
  async runMatchOn(tenantId: number, invoiceId: number): Promise<MatchResult> {
    const rows = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceId)))
      .limit(1)
    const inv = rows[0]
    if (!inv) throw new Error(`Invoice ${invoiceId} not found`)
    if (inv.ocrStatus !== 'done') {
      throw new Error(`Invoice ${invoiceId} is not OCR-done yet`)
    }

    // Re-use cached embeddings if present
    let vendorVec = embeddingService.decode(inv.vendorEmbedding)
    let docVec = embeddingService.decode(inv.docEmbedding)

    if (!vendorVec) {
      const sig = buildVendorSignature(inv)
      if (sig) {
        const r = await embeddingService.embed(tenantId, sig)
        vendorVec = r.vector
      }
    }
    if (!docVec) {
      const sig = buildDocSignature(inv)
      if (sig) {
        const r = await embeddingService.embed(tenantId, sig)
        docVec = r.vector
      }
    }

    const vendorMatch = vendorVec ? await findBestVendor(tenantId, vendorVec) : null
    const poMatch = docVec ? await findBestPO(tenantId, inv.poNumber, docVec) : null

    const { decision, reasoning } = decideMatch(inv, vendorMatch, poMatch)

    // Suggest GL code from vendor category if available
    const suggestedGl = vendorMatch?.vendor.category ?? null

    await db
      .update(invoices)
      .set({
        vendorEmbedding: vendorVec ? embeddingService.encode(vendorVec) : null,
        docEmbedding: docVec ? embeddingService.encode(docVec) : null,
        matchedVendorId: vendorMatch?.vendor.id ?? null,
        vendorMatchScore: vendorMatch
          ? vendorMatch.score.toFixed(4)
          : null,
        matchedPoId: poMatch?.po.id ?? null,
        poMatchScore: poMatch ? poMatch.score.toFixed(4) : null,
        suggestedGlCode: suggestedGl,
        matchDecision: decision,
        matchReasoning: reasoning,
        matchAt: new Date(),
      })
      .where(eq(invoices.id, invoiceId))

    return {
      invoiceId,
      decision,
      vendorId: vendorMatch?.vendor.id ?? null,
      vendorScore: vendorMatch?.score ?? 0,
      poId: poMatch?.po.id ?? null,
      poScore: poMatch?.score ?? 0,
      reasoning,
    }
  },

  /** Run matching on every OCR-done invoice in a batch. */
  async runMatchOnBatch(
    tenantId: number,
    batchId: number,
  ): Promise<MatchResult[]> {
    const rows = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.batchId, batchId)))
    const eligible = rows.filter((r) => r.ocrStatus === 'done')

    const results: MatchResult[] = []
    for (let idx = 0; idx < eligible.length; idx++) {
      const inv = eligible[idx]!
      try {
        const res = await this.runMatchOn(tenantId, inv.id)
        results.push(res)
      } catch (e) {
        results.push({
          invoiceId: inv.id,
          decision: 'EXCEPTION',
          vendorId: null,
          vendorScore: 0,
          poId: null,
          poScore: 0,
          reasoning: 'Embedding error: ' + (e instanceof Error ? e.message : String(e)),
        })
      }
      // Pace embedding calls — Gemini text-embedding-004 free tier is generous
      // but we still avoid hammering. 500ms between calls is plenty.
      if (idx < eligible.length - 1) {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    return results
  },
}
