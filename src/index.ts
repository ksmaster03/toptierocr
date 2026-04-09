import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { cors } from 'hono/cors'
import { env } from './env.ts'
import { authRoutes } from './routes/auth.ts'
import { aiConfigRoutes } from './routes/ai-config.ts'
import { ocrRoutes } from './routes/ocr.ts'
import { documentTypeRoutes } from './routes/document-types.ts'
import { costSettingsRoutes } from './routes/cost-settings.ts'
import { batchRoutes } from './routes/batches.ts'
import { invoiceRoutes } from './routes/invoices.ts'
import { vendorRoutes } from './routes/vendors.ts'
import { purchaseOrderRoutes } from './routes/purchase-orders.ts'

const app = new Hono()

app.use('*', logger())
// CORS only matters for cross-origin tooling. Browser uses same-origin
// since the HTML is served below.
app.use('/api/*', cors({ origin: '*', credentials: true }))

app.get('/health', (c) =>
  c.json({ ok: true, env: env.NODE_ENV, ts: new Date().toISOString() }),
)

app.route('/api/auth', authRoutes)
app.route('/api/ai', aiConfigRoutes)
app.route('/api/ocr', ocrRoutes)
app.route('/api/document-types', documentTypeRoutes)
app.route('/api/cost-settings', costSettingsRoutes)
app.route('/api/batches', batchRoutes)
app.route('/api/invoices', invoiceRoutes)
app.route('/api/vendors', vendorRoutes)
app.route('/api/purchase-orders', purchaseOrderRoutes)

// Serve the HTML mockup at root so the auth cookie is same-origin.
app.get('/', async (c) => {
  const html = await Bun.file('./Toptier-AI-OCR-v2.html').text()
  return c.html(html)
})

app.onError((err, c) => {
  console.error('[unhandled]', err)
  return c.json({ error: err.message }, 500)
})

console.log(`🚀 Toptier AI OCR listening on http://localhost:${env.PORT}`)

export default {
  port: env.PORT,
  fetch: app.fetch,
}
