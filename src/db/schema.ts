import {
  mysqlTable,
  int,
  tinyint,
  varchar,
  text,
  timestamp,
  decimal,
  uniqueIndex,
  index,
} from 'drizzle-orm/mysql-core'

export const tenants = mysqlTable('tenants', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/**
 * Auth users. Two roles for the MVP:
 *   - 'admin' = full access (settings, AI config, OCR, review, submit)
 *   - 'demo'  = documents only (Steps 1–4); no settings, no submit
 */
export const users = mysqlTable(
  'users',
  {
    id: int('id').autoincrement().primaryKey(),
    tenantId: int('tenant_id').notNull(),
    username: varchar('username', { length: 64 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    role: varchar('role', { length: 16 }).notNull(),
    fullName: varchar('full_name', { length: 128 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    lastLoginAt: timestamp('last_login_at'),
  },
  (t) => ({
    usernameUq: uniqueIndex('users_username_uq').on(t.username),
  }),
)

/**
 * Active AI provider configuration per tenant.
 * The dropdown in the UI is driven by `providerRegistry.list()`,
 * the user picks one and we save its `id` here.
 */
export const aiConfigs = mysqlTable(
  'ai_configs',
  {
    id: int('id').autoincrement().primaryKey(),
    tenantId: int('tenant_id').notNull(),
    ocrProviderId: varchar('ocr_provider_id', { length: 64 }).notNull(),
    fallbackProviderId: varchar('fallback_provider_id', { length: 64 }),
    fallbackThreshold: decimal('fallback_threshold', { precision: 3, scale: 2 })
      .notNull()
      .default('0.80'),
    monthlyBudgetThb: decimal('monthly_budget_thb', { precision: 10, scale: 2 })
      .notNull()
      .default('1000.00'),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    tenantUq: uniqueIndex('ai_configs_tenant_uq').on(t.tenantId),
  }),
)

/**
 * Encrypted API credentials per (tenant, provider).
 * cipherText/iv/authTag are produced by src/crypto.ts using the master key.
 */
export const apiCredentials = mysqlTable(
  'api_credentials',
  {
    id: int('id').autoincrement().primaryKey(),
    tenantId: int('tenant_id').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    cipherText: text('cipher_text').notNull(),
    iv: varchar('iv', { length: 64 }).notNull(),
    authTag: varchar('auth_tag', { length: 64 }).notNull(),
    keyHint: varchar('key_hint', { length: 32 }).notNull(), // masked preview
    createdAt: timestamp('created_at').defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at'),
  },
  (t) => ({
    tenantProviderUq: uniqueIndex('api_credentials_tenant_provider_uq').on(
      t.tenantId,
      t.provider,
    ),
  }),
)

/** Per-call usage log — drives the cost dashboard and budget guard. */
export const aiUsageLog = mysqlTable(
  'ai_usage_log',
  {
    id: int('id').autoincrement().primaryKey(),
    tenantId: int('tenant_id').notNull(),
    invoiceId: int('invoice_id'),
    provider: varchar('provider', { length: 64 }).notNull(),
    inputTokens: int('input_tokens').notNull(),
    outputTokens: int('output_tokens').notNull(),
    costThb: decimal('cost_thb', { precision: 10, scale: 4 }).notNull(),
    latencyMs: int('latency_ms').notNull(),
    fallbackFrom: varchar('fallback_from', { length: 64 }),
    ts: timestamp('ts').defaultNow().notNull(),
  },
  (t) => ({
    tenantTsIdx: index('ai_usage_log_tenant_ts_idx').on(t.tenantId, t.ts),
  }),
)

/**
 * Document type master. Drives the dropdown in Step 1 (slots) and the
 * Settings → "ประเภทเอกสาร" admin section. Tenant-scoped + soft delete via active.
 */
export const documentTypes = mysqlTable(
  'document_types',
  {
    id: int('id').autoincrement().primaryKey(),
    tenantId: int('tenant_id').notNull(),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    description: text('description'),
    icon: varchar('icon', { length: 64 }).notNull().default('description'),
    monthlyVolumeLabel: varchar('monthly_volume_label', { length: 64 }),
    flowDescription: text('flow_description'),
    outputTarget: varchar('output_target', { length: 64 }),
    active: tinyint('active').notNull().default(1),
    sortOrder: int('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    tenantCodeUq: uniqueIndex('document_types_tenant_code_uq').on(
      t.tenantId,
      t.code,
    ),
  }),
)

/**
 * Cost estimation master config. One row per tenant. Drives the
 * "ประเมินค่าใช้จ่าย" panel in Step 1 and the admin master page.
 *
 * provider_overrides: JSON string mapping provider id → custom THB price.
 *   { "gemini-2.0-flash": { "inputCostPer1k": 0.0036, "outputCostPer1k": 0.0144 } }
 * If empty/null, the registry default cost is used.
 */
export const costSettings = mysqlTable(
  'cost_settings',
  {
    id: int('id').autoincrement().primaryKey(),
    tenantId: int('tenant_id').notNull(),
    usdToThb: decimal('usd_to_thb', { precision: 8, scale: 4 })
      .notNull()
      .default('36.0000'),
    ocrInputTokensPerPage: int('ocr_input_tokens_per_page').notNull().default(1500),
    ocrOutputTokensPerPage: int('ocr_output_tokens_per_page').notNull().default(600),
    matchingInputTokens: int('matching_input_tokens').notNull().default(1200),
    matchingOutputTokens: int('matching_output_tokens').notNull().default(400),
    pagesPerFile: decimal('pages_per_file', { precision: 4, scale: 2 })
      .notNull()
      .default('1.50'),
    matchingProviderId: varchar('matching_provider_id', { length: 64 }),
    providerOverrides: text('provider_overrides'),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    tenantUq: uniqueIndex('cost_settings_tenant_uq').on(t.tenantId),
  }),
)

/**
 * Sprint 2 — persistence layer for the upload→OCR pipeline.
 *
 * batches:       a group of invoices uploaded together in one Step 1 submission
 * invoices:      one row per uploaded file, holds storage path + OCR results +
 *                denormalized extracted fields for fast querying
 * invoice_lines: line items extracted from each invoice
 */
export const batches = mysqlTable(
  'batches',
  {
    id: int('id').autoincrement().primaryKey(),
    tenantId: int('tenant_id').notNull(),
    createdByUserId: int('created_by_user_id').notNull(),
    name: varchar('name', { length: 64 }).notNull(),
    /** uploaded | processing | reviewing | submitted | done | cancelled */
    status: varchar('status', { length: 16 }).notNull().default('uploaded'),
    totalFiles: int('total_files').notNull().default(0),
    totalProcessed: int('total_processed').notNull().default(0),
    totalCostThb: decimal('total_cost_thb', { precision: 10, scale: 4 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    tenantNameUq: uniqueIndex('batches_tenant_name_uq').on(t.tenantId, t.name),
    tenantStatusIdx: index('batches_tenant_status_idx').on(t.tenantId, t.status),
  }),
)

export const invoices = mysqlTable(
  'invoices',
  {
    id: int('id').autoincrement().primaryKey(),
    tenantId: int('tenant_id').notNull(),
    batchId: int('batch_id').notNull(),
    docTypeCode: varchar('doc_type_code', { length: 32 }).notNull(),
    // file
    originalFilename: varchar('original_filename', { length: 255 }).notNull(),
    storagePath: varchar('storage_path', { length: 512 }).notNull(),
    mimeType: varchar('mime_type', { length: 64 }).notNull(),
    fileSizeBytes: int('file_size_bytes').notNull(),
    // ocr
    /** pending | processing | done | failed */
    ocrStatus: varchar('ocr_status', { length: 16 }).notNull().default('pending'),
    ocrProviderUsed: varchar('ocr_provider_used', { length: 64 }),
    ocrProviderRequested: varchar('ocr_provider_requested', { length: 64 }),
    ocrAvgConfidence: decimal('ocr_avg_confidence', { precision: 5, scale: 4 }),
    ocrInputTokens: int('ocr_input_tokens'),
    ocrOutputTokens: int('ocr_output_tokens'),
    ocrCostThb: decimal('ocr_cost_thb', { precision: 10, scale: 6 }),
    ocrLatencyMs: int('ocr_latency_ms'),
    ocrRawJson: text('ocr_raw_json'),
    ocrError: text('ocr_error'),
    ocrAt: timestamp('ocr_at'),
    // extracted fields (denormalized)
    vendorName: varchar('vendor_name', { length: 255 }),
    vendorTaxId: varchar('vendor_tax_id', { length: 64 }),
    invoiceNumber: varchar('invoice_number', { length: 128 }),
    invoiceDate: varchar('invoice_date', { length: 32 }),
    poNumber: varchar('po_number', { length: 128 }),
    subtotalAmount: decimal('subtotal_amount', { precision: 15, scale: 2 }),
    vatAmount: decimal('vat_amount', { precision: 15, scale: 2 }),
    totalAmount: decimal('total_amount', { precision: 15, scale: 2 }),
    currency: varchar('currency', { length: 8 }),
    paymentTerms: varchar('payment_terms', { length: 128 }),
    // matching (Sprint 3)
    docEmbedding: text('doc_embedding'),
    vendorEmbedding: text('vendor_embedding'),
    matchedVendorId: int('matched_vendor_id'),
    vendorMatchScore: decimal('vendor_match_score', { precision: 5, scale: 4 }),
    matchedPoId: int('matched_po_id'),
    poMatchScore: decimal('po_match_score', { precision: 5, scale: 4 }),
    suggestedGlCode: varchar('suggested_gl_code', { length: 64 }),
    suggestedCostCenter: varchar('suggested_cost_center', { length: 64 }),
    /** AUTO_POST | REVIEW | EXCEPTION */
    matchDecision: varchar('match_decision', { length: 16 }),
    matchReasoning: text('match_reasoning'),
    matchAt: timestamp('match_at'),
    // review
    /** pending | approved | hold | rejected */
    reviewStatus: varchar('review_status', { length: 16 }).notNull().default('pending'),
    reviewedByUserId: int('reviewed_by_user_id'),
    reviewedAt: timestamp('reviewed_at'),
    reviewNote: text('review_note'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    batchIdx: index('invoices_batch_idx').on(t.batchId),
    tenantStatusIdx: index('invoices_tenant_status_idx').on(t.tenantId, t.ocrStatus),
  }),
)

/**
 * Sprint 3 — Vendor / PO / GR master + vector embeddings.
 *
 * Embedding columns are LONGTEXT (JSON-stringified float[]) for portability.
 * SeekDB does have native VECTOR type, but exact syntax varies by version,
 * so we use JSON now and may migrate to VECTOR(768) later. With ~1k vendors
 * cosine similarity in JS is fine.
 */
export const vendors = mysqlTable(
  'vendors',
  {
    id: int('id').autoincrement().primaryKey(),
    tenantId: int('tenant_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    taxId: varchar('tax_id', { length: 64 }),
    sapCode: varchar('sap_code', { length: 64 }),
    category: varchar('category', { length: 64 }),
    embedding: text('embedding'),
    active: tinyint('active').notNull().default(1),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    tenantIdx: index('vendors_tenant_idx').on(t.tenantId),
    taxIdIdx: index('vendors_taxid_idx').on(t.taxId),
  }),
)

export const purchaseOrders = mysqlTable(
  'purchase_orders',
  {
    id: int('id').autoincrement().primaryKey(),
    tenantId: int('tenant_id').notNull(),
    poNo: varchar('po_no', { length: 64 }).notNull(),
    vendorId: int('vendor_id'),
    vendorNameSnapshot: varchar('vendor_name_snapshot', { length: 255 }),
    totalAmount: decimal('total_amount', { precision: 15, scale: 2 }),
    currency: varchar('currency', { length: 8 }).default('THB'),
    /** open | closed | cancelled */
    status: varchar('status', { length: 16 }).notNull().default('open'),
    description: text('description'),
    descriptionEmbedding: text('description_embedding'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    tenantNoUq: uniqueIndex('po_tenant_no_uq').on(t.tenantId, t.poNo),
    vendorIdx: index('po_vendor_idx').on(t.vendorId),
  }),
)

export const goodsReceipts = mysqlTable(
  'goods_receipts',
  {
    id: int('id').autoincrement().primaryKey(),
    tenantId: int('tenant_id').notNull(),
    grNo: varchar('gr_no', { length: 64 }).notNull(),
    poId: int('po_id'),
    receivedAt: varchar('received_at', { length: 32 }),
    totalReceived: decimal('total_received', { precision: 15, scale: 2 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    tenantNoUq: uniqueIndex('gr_tenant_no_uq').on(t.tenantId, t.grNo),
    poIdx: index('gr_po_idx').on(t.poId),
  }),
)

export const invoiceLines = mysqlTable(
  'invoice_lines',
  {
    id: int('id').autoincrement().primaryKey(),
    invoiceId: int('invoice_id').notNull(),
    lineNo: int('line_no').notNull(),
    description: text('description'),
    quantity: decimal('quantity', { precision: 12, scale: 4 }),
    unitPrice: decimal('unit_price', { precision: 15, scale: 4 }),
    amount: decimal('amount', { precision: 15, scale: 2 }),
    glCode: varchar('gl_code', { length: 64 }),
    costCenter: varchar('cost_center', { length: 64 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    invoiceIdx: index('invoice_lines_invoice_idx').on(t.invoiceId),
  }),
)

export type Tenant = typeof tenants.$inferSelect
export type User = typeof users.$inferSelect
export type AiConfig = typeof aiConfigs.$inferSelect
export type ApiCredential = typeof apiCredentials.$inferSelect
export type AiUsageLog = typeof aiUsageLog.$inferSelect
export type DocumentType = typeof documentTypes.$inferSelect
export type CostSettings = typeof costSettings.$inferSelect
export type Batch = typeof batches.$inferSelect
export type Invoice = typeof invoices.$inferSelect
export type InvoiceLine = typeof invoiceLines.$inferSelect
export type Vendor = typeof vendors.$inferSelect
export type PurchaseOrder = typeof purchaseOrders.$inferSelect
export type GoodsReceipt = typeof goodsReceipts.$inferSelect

/**
 * Sprint 5 — record of every batch posting attempt (test or real).
 */
export const postingLogs = mysqlTable(
  'posting_logs',
  {
    id: int('id').autoincrement().primaryKey(),
    tenantId: int('tenant_id').notNull(),
    batchId: int('batch_id').notNull(),
    postedByUserId: int('posted_by_user_id').notNull(),
    target: varchar('target', { length: 32 }).notNull(),
    /** test | real */
    mode: varchar('mode', { length: 16 }).notNull(),
    /** SUCCESS | FAILED | PARTIAL */
    status: varchar('status', { length: 16 }).notNull(),
    totalDocuments: int('total_documents').notNull().default(0),
    totalAmount: decimal('total_amount', { precision: 15, scale: 2 }),
    responseJson: text('response_json'),
    postedAt: timestamp('posted_at').defaultNow().notNull(),
  },
  (t) => ({
    batchIdx: index('posting_logs_batch_idx').on(t.batchId),
  }),
)
export type PostingLog = typeof postingLogs.$inferSelect
