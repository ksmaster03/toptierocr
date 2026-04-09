import { Hono } from 'hono'
import { ocrService } from '../services/ocr.ts'
import { authMiddleware } from '../auth/middleware.ts'

export const ocrRoutes = new Hono()

// Both 'admin' and 'demo' can run OCR — it counts as document work.
ocrRoutes.use('*', authMiddleware)

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
])

const MAX_BYTES = 20 * 1024 * 1024 // 20 MB

/**
 * POST /api/ocr/extract
 * Multipart: file=<binary>
 * Optional query: ?provider=<id>   to override the configured provider
 *                                   (used by the dropdown "test now" button)
 */
ocrRoutes.post('/extract', async (c) => {
  const form = await c.req.formData().catch(() => null)
  if (!form) {
    return c.json({ error: 'expected multipart/form-data' }, 400)
  }
  const file = form.get('file')
  if (!(file instanceof File)) {
    return c.json({ error: 'missing file field' }, 400)
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return c.json({ error: `unsupported mime: ${file.type}` }, 415)
  }
  if (file.size > MAX_BYTES) {
    return c.json({ error: `file too large (max ${MAX_BYTES} bytes)` }, 413)
  }

  const buf = new Uint8Array(await file.arrayBuffer())
  const providerOverride = c.req.query('provider') || undefined
  const user = c.get('user')

  try {
    const result = await ocrService.run({
      tenantId: user.tenantId,
      fileBuffer: buf,
      mimeType: file.type,
      providerOverride,
    })
    return c.json({
      providerUsed: result.providerUsed,
      fellBackFrom: result.fellBackFrom ?? null,
      avgConfidence: result.avgConfidence,
      latencyMs: result.latencyMs,
      tokens: { input: result.inputTokens, output: result.outputTokens },
      costThb: Number(result.costThb.toFixed(4)),
      fields: result.fields,
      rawText: result.rawText,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    return c.json({ error: msg }, 500)
  }
})
