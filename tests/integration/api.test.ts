import { describe, it, expect, beforeAll } from 'vitest'

/**
 * Integration tests run against the live dev server.
 *
 * Pre-requisites:
 *   - `bun run dev` is running on http://localhost:3737
 *   - SeekDB Docker is up
 *   - admin/admin123 user is seeded
 *
 * These tests use the real DB and create real rows. They are designed to
 * be idempotent — they only assert on shapes, not exact IDs.
 */

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3737'
let adminCookie = ''
let demoCookie = ''

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(`login failed for ${username}: ${res.status}`)
  const setCookie = res.headers.get('set-cookie') ?? ''
  // Pull just the auth=...; pair
  const match = setCookie.match(/auth=[^;]+/)
  return match?.[0] ?? ''
}

beforeAll(async () => {
  // Sanity-check the server is up
  const health = await fetch(`${BASE}/health`).catch(() => null)
  if (!health || !health.ok) {
    throw new Error(`Dev server not reachable at ${BASE}. Run 'bun run dev' first.`)
  }
  adminCookie = await login('admin', 'admin123')
  demoCookie = await login('demo', 'demo123')
  expect(adminCookie).toMatch(/^auth=/)
  expect(demoCookie).toMatch(/^auth=/)
})

describe('GET /health', () => {
  it('returns ok', async () => {
    const r = await fetch(`${BASE}/health`)
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.ok).toBe(true)
  })
})

describe('POST /api/auth/login', () => {
  it('rejects wrong password', async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'WRONG' }),
    })
    expect(r.status).toBe(401)
  })

  it('rejects unknown user', async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'no-such-user', password: 'whatever' }),
    })
    expect(r.status).toBe(401)
  })
})

describe('GET /api/auth/me', () => {
  it('admin returns role=admin', async () => {
    const r = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: adminCookie } })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.user.username).toBe('admin')
    expect(j.user.role).toBe('admin')
  })

  it('demo returns role=demo', async () => {
    const r = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: demoCookie } })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.user.role).toBe('demo')
  })

  it('without cookie returns 401', async () => {
    const r = await fetch(`${BASE}/api/auth/me`)
    expect(r.status).toBe(401)
  })
})

describe('RBAC enforcement', () => {
  it('demo cannot read /api/ai/config (admin only) → 403', async () => {
    const r = await fetch(`${BASE}/api/ai/config`, { headers: { cookie: demoCookie } })
    expect(r.status).toBe(403)
  })

  it('demo cannot save credentials → 403', async () => {
    const r = await fetch(`${BASE}/api/ai/credentials`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: demoCookie },
      body: JSON.stringify({ providerId: 'gemini-2.5-flash', apiKey: 'shouldfail' }),
    })
    expect(r.status).toBe(403)
  })

  it('demo cannot real-post a batch → 403', async () => {
    // We don't actually need a real batch id — middleware fires first
    const r = await fetch(`${BASE}/api/batches/1/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: demoCookie },
      body: JSON.stringify({ target: 'csv', mode: 'real' }),
    })
    expect(r.status).toBe(403)
  })

  it('admin CAN read /api/ai/config', async () => {
    const r = await fetch(`${BASE}/api/ai/config`, { headers: { cookie: adminCookie } })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.ocrProviderId).toBeTruthy()
  })
})

describe('GET /api/document-types', () => {
  it('returns at least the 3 seeded types for admin', async () => {
    const r = await fetch(`${BASE}/api/document-types`, { headers: { cookie: adminCookie } })
    expect(r.status).toBe(200)
    const j = await r.json()
    const codes = j.types.map((t: any) => t.code)
    expect(codes).toContain('stock')
    expect(codes).toContain('gp')
    expect(codes).toContain('tx')
  })

  it('demo can also read (any logged-in user)', async () => {
    const r = await fetch(`${BASE}/api/document-types`, { headers: { cookie: demoCookie } })
    expect(r.status).toBe(200)
  })
})

describe('GET /api/cost-settings', () => {
  it('returns effectiveCosts for both providers', async () => {
    const r = await fetch(`${BASE}/api/cost-settings`, { headers: { cookie: adminCookie } })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.effectiveCosts).toBeDefined()
    expect(j.effectiveCosts['gemini-2.5-flash']).toBeDefined()
    expect(j.effectiveCosts['claude-haiku-4-5']).toBeDefined()
    expect(typeof j.usdToThb).toBe('number')
  })
})

describe('GET /api/vendors / /api/purchase-orders (Sprint 3 masters)', () => {
  it('vendors list responds 200', async () => {
    const r = await fetch(`${BASE}/api/vendors`, { headers: { cookie: adminCookie } })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(Array.isArray(j.vendors)).toBe(true)
  })

  it('purchase-orders list responds 200', async () => {
    const r = await fetch(`${BASE}/api/purchase-orders`, { headers: { cookie: adminCookie } })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(Array.isArray(j.pos)).toBe(true)
  })
})

describe('Batches end-to-end (upload → fetch)', () => {
  let createdBatchId: number | null = null

  it('POST /api/batches creates a batch from multipart upload', async () => {
    const tinyPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x03, 0x00, 0x01, 0x5a, 0xfa, 0x88, 0xf7, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ])
    const fd = new FormData()
    fd.append('files', new Blob([tinyPng], { type: 'image/png' }), 'vitest.png')
    fd.append('types', 'stock')
    fd.append('provider', 'gemini-2.5-flash')

    const r = await fetch(`${BASE}/api/batches`, {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: fd,
    })
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.batch.name).toMatch(/^BATCH-\d{8}-\d{3}$/)
    expect(j.batch.totalFiles).toBe(1)
    expect(j.invoices).toHaveLength(1)
    expect(j.invoices[0].docTypeCode).toBe('stock')
    expect(j.invoices[0].ocrStatus).toBe('pending')
    createdBatchId = j.batch.id
  })

  it('GET /api/batches/:id returns the just-created batch', async () => {
    if (createdBatchId == null) throw new Error('previous test must run first')
    const r = await fetch(`${BASE}/api/batches/${createdBatchId}`, {
      headers: { cookie: adminCookie },
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.batch.id).toBe(createdBatchId)
    expect(j.invoices.length).toBeGreaterThanOrEqual(1)
  })

  it('GET /api/invoices/:id/file streams the original file', async () => {
    if (createdBatchId == null) throw new Error('previous test must run first')
    const get = await fetch(`${BASE}/api/batches/${createdBatchId}`, {
      headers: { cookie: adminCookie },
    })
    const data = await get.json()
    const invId = data.invoices[0].id
    const r = await fetch(`${BASE}/api/invoices/${invId}/file`, {
      headers: { cookie: adminCookie },
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/image\/png/)
    const buf = await r.arrayBuffer()
    expect(buf.byteLength).toBeGreaterThan(0)
  })

  it('POST /api/batches with no files → 400', async () => {
    const fd = new FormData()
    const r = await fetch(`${BASE}/api/batches`, {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: fd,
    })
    expect(r.status).toBe(400)
  })

  it('POST /api/batches with mismatched types[] count → 400', async () => {
    const tinyPng = new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' })
    const fd = new FormData()
    fd.append('files', tinyPng, 'a.png')
    fd.append('files', tinyPng, 'b.png')
    fd.append('types', 'stock')
    // missing second type
    const r = await fetch(`${BASE}/api/batches`, {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: fd,
    })
    expect(r.status).toBe(400)
  })
})

describe('Settings round-trip', () => {
  it('PUT /api/cost-settings persists provider override + restores', async () => {
    const before = await fetch(`${BASE}/api/cost-settings`, {
      headers: { cookie: adminCookie },
    }).then((r) => r.json())

    const r = await fetch(`${BASE}/api/cost-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        providerOverrides: {
          'gemini-2.5-flash': { inputCostPer1k: 0.0123, outputCostPer1k: 0.0456 },
        },
      }),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.effectiveCosts['gemini-2.5-flash'].source).toBe('override')
    expect(j.effectiveCosts['gemini-2.5-flash'].inputCostPer1k).toBeCloseTo(0.0123)

    // Restore previous overrides
    await fetch(`${BASE}/api/cost-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ providerOverrides: before.providerOverrides ?? {} }),
    })
  })
})
