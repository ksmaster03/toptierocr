/**
 * Shared invoice-extraction prompt + JSON schema.
 * Both Gemini and Claude get the same instructions so the registry can swap
 * them with no behaviour drift.
 */

export const INVOICE_FIELDS = [
  'vendor_name',
  'vendor_tax_id',
  'invoice_number',
  'invoice_date',
  'po_number',
  'subtotal',
  'vat_amount',
  'total_amount',
  'currency',
  'payment_terms',
] as const

export const INVOICE_PROMPT = `You are an OCR engine for Thai/English tax invoices (ใบกำกับภาษี).

Extract these fields from the document image and return a SINGLE JSON object
with this exact shape — no markdown, no commentary, no code fences:

{
  "vendor_name": string,
  "vendor_tax_id": string,
  "invoice_number": string,
  "invoice_date": "DD/MM/YYYY",
  "po_number": string,
  "subtotal": number,
  "vat_amount": number,
  "total_amount": number,
  "currency": "THB" | "USD" | string,
  "payment_terms": string,
  "line_items": [
    { "description": string, "quantity": number, "unit_price": number, "amount": number }
  ],
  "raw_text": string,
  "field_confidence": {
    "vendor_name": number,
    "vendor_tax_id": number,
    "invoice_number": number,
    "invoice_date": number,
    "po_number": number,
    "subtotal": number,
    "vat_amount": number,
    "total_amount": number,
    "currency": number,
    "payment_terms": number
  }
}

Rules:
- Each field_confidence value is between 0.0 and 1.0 — your honest belief
  that the value is correct (not the OCR character confidence).
- If a field is missing from the document, return "" (or 0 for numbers) and
  set its confidence to 0.0.
- Numbers must be plain JSON numbers, no thousand separators, no currency
  symbols.
- raw_text must contain the verbatim text you read from the page.
- Output JSON only.`

/** Used by both providers to convert their JSON response into OCRField[]. */
export function extractFieldsFromJson(json: unknown): {
  fields: { key: string; value: string; confidence: number }[]
  rawText: string
  avgConfidence: number
} {
  if (!json || typeof json !== 'object') {
    return { fields: [], rawText: '', avgConfidence: 0 }
  }
  const obj = json as Record<string, unknown>
  const conf = (obj.field_confidence ?? {}) as Record<string, unknown>

  const fields = INVOICE_FIELDS.map((k) => {
    const v = obj[k]
    const c = Number(conf[k] ?? 0)
    return {
      key: k,
      value: v == null ? '' : String(v),
      confidence: Number.isFinite(c) ? c : 0,
    }
  })

  const avg =
    fields.length === 0
      ? 0
      : fields.reduce((s, f) => s + f.confidence, 0) / fields.length

  return {
    fields,
    rawText: typeof obj.raw_text === 'string' ? obj.raw_text : '',
    avgConfidence: avg,
  }
}
