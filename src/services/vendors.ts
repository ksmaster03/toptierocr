import { eq, and, asc } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { vendors, purchaseOrders, type Vendor, type PurchaseOrder } from '../db/schema.ts'
import { embeddingService } from './embedding.ts'

export interface CreateVendorInput {
  tenantId: number
  name: string
  taxId?: string | null
  sapCode?: string | null
  category?: string | null
}

export interface CreatePoInput {
  tenantId: number
  poNo: string
  vendorId?: number | null
  vendorNameSnapshot?: string | null
  totalAmount?: number | null
  currency?: string
  description?: string | null
}

export const vendorMasterService = {
  async listVendors(tenantId: number): Promise<Vendor[]> {
    return db
      .select()
      .from(vendors)
      .where(and(eq(vendors.tenantId, tenantId), eq(vendors.active, 1)))
      .orderBy(asc(vendors.name))
  },

  async createVendor(input: CreateVendorInput): Promise<Vendor> {
    // Embed the vendor signature so matching works immediately.
    const sig = [input.name, input.taxId].filter(Boolean).join(' | ')
    let embeddingJson: string | null = null
    try {
      const r = await embeddingService.embed(input.tenantId, sig)
      embeddingJson = embeddingService.encode(r.vector)
    } catch (e) {
      // Don't fail vendor create if embedding fails — can re-embed later
      console.warn('[vendors] embedding skipped:', (e as Error).message)
    }

    const [r] = await db.insert(vendors).values({
      tenantId: input.tenantId,
      name: input.name,
      taxId: input.taxId ?? null,
      sapCode: input.sapCode ?? null,
      category: input.category ?? null,
      embedding: embeddingJson,
    })
    const id = (r as { insertId: number }).insertId
    const rows = await db.select().from(vendors).where(eq(vendors.id, id)).limit(1)
    return rows[0]!
  },

  async listPos(tenantId: number): Promise<PurchaseOrder[]> {
    return db
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.tenantId, tenantId))
      .orderBy(asc(purchaseOrders.poNo))
  },

  async createPo(input: CreatePoInput): Promise<PurchaseOrder> {
    const sig = [
      input.poNo,
      input.vendorNameSnapshot,
      input.description,
      input.totalAmount ? `total=${input.totalAmount}` : null,
    ]
      .filter(Boolean)
      .join(' | ')

    let embeddingJson: string | null = null
    try {
      const r = await embeddingService.embed(input.tenantId, sig)
      embeddingJson = embeddingService.encode(r.vector)
    } catch (e) {
      console.warn('[po] embedding skipped:', (e as Error).message)
    }

    const [r] = await db.insert(purchaseOrders).values({
      tenantId: input.tenantId,
      poNo: input.poNo,
      vendorId: input.vendorId ?? null,
      vendorNameSnapshot: input.vendorNameSnapshot ?? null,
      totalAmount: input.totalAmount != null ? String(input.totalAmount) : null,
      currency: input.currency ?? 'THB',
      description: input.description ?? null,
      descriptionEmbedding: embeddingJson,
    })
    const id = (r as { insertId: number }).insertId
    const rows = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1)
    return rows[0]!
  },
}
