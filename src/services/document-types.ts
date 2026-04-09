import { eq, and, asc } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { documentTypes, type DocumentType } from '../db/schema.ts'

export interface CreateDocTypeInput {
  tenantId: number
  code: string
  name: string
  description?: string | null
  icon?: string
  monthlyVolumeLabel?: string | null
  flowDescription?: string | null
  outputTarget?: string | null
  sortOrder?: number
}

export interface UpdateDocTypeInput {
  name?: string
  description?: string | null
  icon?: string
  monthlyVolumeLabel?: string | null
  flowDescription?: string | null
  outputTarget?: string | null
  sortOrder?: number
  active?: number
}

export const documentTypeService = {
  /** List active types for a tenant, sorted by sort_order. */
  async listActive(tenantId: number): Promise<DocumentType[]> {
    return db
      .select()
      .from(documentTypes)
      .where(and(eq(documentTypes.tenantId, tenantId), eq(documentTypes.active, 1)))
      .orderBy(asc(documentTypes.sortOrder), asc(documentTypes.id))
  },

  /** List all (including inactive) — for admin master page. */
  async listAll(tenantId: number): Promise<DocumentType[]> {
    return db
      .select()
      .from(documentTypes)
      .where(eq(documentTypes.tenantId, tenantId))
      .orderBy(asc(documentTypes.sortOrder), asc(documentTypes.id))
  },

  async create(input: CreateDocTypeInput): Promise<DocumentType> {
    await db.insert(documentTypes).values({
      tenantId: input.tenantId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      icon: input.icon ?? 'description',
      monthlyVolumeLabel: input.monthlyVolumeLabel ?? null,
      flowDescription: input.flowDescription ?? null,
      outputTarget: input.outputTarget ?? null,
      sortOrder: input.sortOrder ?? 0,
    })
    const rows = await db
      .select()
      .from(documentTypes)
      .where(
        and(
          eq(documentTypes.tenantId, input.tenantId),
          eq(documentTypes.code, input.code),
        ),
      )
      .limit(1)
    return rows[0]!
  },

  async update(
    tenantId: number,
    id: number,
    patch: UpdateDocTypeInput,
  ): Promise<DocumentType | null> {
    const update: Record<string, unknown> = {}
    for (const k of [
      'name',
      'description',
      'icon',
      'monthlyVolumeLabel',
      'flowDescription',
      'outputTarget',
      'sortOrder',
      'active',
    ] as const) {
      if (patch[k] !== undefined) update[k] = patch[k]
    }
    if (Object.keys(update).length === 0) return null

    await db
      .update(documentTypes)
      .set(update)
      .where(
        and(eq(documentTypes.tenantId, tenantId), eq(documentTypes.id, id)),
      )

    const rows = await db
      .select()
      .from(documentTypes)
      .where(
        and(eq(documentTypes.tenantId, tenantId), eq(documentTypes.id, id)),
      )
      .limit(1)
    return rows[0] ?? null
  },

  /** Soft delete by setting active=0. */
  async softDelete(tenantId: number, id: number): Promise<void> {
    await db
      .update(documentTypes)
      .set({ active: 0 })
      .where(
        and(eq(documentTypes.tenantId, tenantId), eq(documentTypes.id, id)),
      )
  },
}
