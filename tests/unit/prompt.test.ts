import { describe, it, expect } from 'vitest'
import {
  INVOICE_FIELDS,
  INVOICE_PROMPT,
  extractFieldsFromJson,
} from '../../src/providers/ocr/prompt.ts'

describe('OCR prompt + extractFieldsFromJson', () => {
  it('exposes the canonical field list', () => {
    expect(INVOICE_FIELDS).toContain('vendor_name')
    expect(INVOICE_FIELDS).toContain('invoice_number')
    expect(INVOICE_FIELDS).toContain('total_amount')
    expect(INVOICE_FIELDS.length).toBeGreaterThanOrEqual(10)
  })

  it('prompt mentions JSON-only output', () => {
    expect(INVOICE_PROMPT).toMatch(/JSON/i)
    expect(INVOICE_PROMPT).toMatch(/no markdown/i)
  })

  it('extractFieldsFromJson handles a well-formed Gemini response', () => {
    const fakeResponse = {
      vendor_name: 'Logistics Partner Ltd.',
      vendor_tax_id: '0105556123456',
      invoice_number: 'INV-2025-00018',
      invoice_date: '05/04/2025',
      po_number: 'PO-2025-1188',
      subtotal: 10000,
      vat_amount: 700,
      total_amount: 10700,
      currency: 'THB',
      payment_terms: 'Net 30',
      raw_text: 'TAX INVOICE\nTotal: 10,700.00',
      field_confidence: {
        vendor_name: 0.95,
        invoice_number: 0.98,
        total_amount: 0.92,
      },
    }
    const out = extractFieldsFromJson(fakeResponse)
    expect(out.fields).toHaveLength(INVOICE_FIELDS.length)
    const vendor = out.fields.find((f) => f.key === 'vendor_name')
    expect(vendor?.value).toBe('Logistics Partner Ltd.')
    expect(vendor?.confidence).toBe(0.95)
    const invNo = out.fields.find((f) => f.key === 'invoice_number')
    expect(invNo?.confidence).toBe(0.98)
    expect(out.rawText).toContain('TAX INVOICE')
    expect(out.avgConfidence).toBeGreaterThan(0)
    expect(out.avgConfidence).toBeLessThanOrEqual(1)
  })

  it('extractFieldsFromJson is safe for null / non-object', () => {
    expect(extractFieldsFromJson(null).fields).toEqual([])
    expect(extractFieldsFromJson(undefined).fields).toEqual([])
    expect(extractFieldsFromJson('garbage').fields).toEqual([])
    expect(extractFieldsFromJson(42).fields).toEqual([])
  })

  it('missing fields default to empty value + 0 confidence', () => {
    const out = extractFieldsFromJson({
      vendor_name: 'Only Vendor',
      field_confidence: { vendor_name: 0.7 },
    })
    const total = out.fields.find((f) => f.key === 'total_amount')
    expect(total?.value).toBe('')
    expect(total?.confidence).toBe(0)
  })
})
