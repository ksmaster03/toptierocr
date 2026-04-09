import { aiConfigService } from './ai-config.ts'

/**
 * Embedding provider abstraction. Returns a unit-norm-ish float array we
 * can store as JSON in TEXT and compare via cosine similarity in JS.
 *
 * Sprint 3 ships only the Gemini text-embedding-004 implementation, but
 * adding more is just an extra branch in `embed()`.
 */
export interface EmbeddingResult {
  vector: number[]
  dim: number
  model: string
  inputTokens: number
}

const GEMINI_EMBED_MODEL = 'gemini-embedding-001'
const GEMINI_EMBED_DIM = 3072  // gemini-embedding-001 default dimension

/**
 * Call Gemini text-embedding API. The API key is borrowed from the saved
 * `gemini-2.5-flash` credential row — we assume the same Google project has
 * the embedding model enabled (it does, in the same free tier project).
 */
async function embedWithGemini(
  tenantId: number,
  text: string,
): Promise<EmbeddingResult> {
  const apiKey = await aiConfigService.loadDecryptedKey(tenantId, 'gemini-2.5-flash')
  if (!apiKey) {
    throw new Error('No Gemini API key configured (needed for embeddings too)')
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent?key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: `models/${GEMINI_EMBED_MODEL}`,
      content: { parts: [{ text }] },
    }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`Gemini embed ${res.status}: ${t.slice(0, 200)}`)
  }
  const payload = (await res.json()) as { embedding?: { values?: number[] } }
  const values = payload.embedding?.values ?? []
  if (values.length === 0) {
    throw new Error('Gemini returned empty embedding')
  }
  return {
    vector: values,
    dim: values.length,
    model: GEMINI_EMBED_MODEL,
    // Gemini doesn't return token count for embed; estimate ~1 token / 4 chars
    inputTokens: Math.ceil(text.length / 4),
  }
}

export const embeddingService = {
  async embed(tenantId: number, text: string): Promise<EmbeddingResult> {
    const trimmed = (text || '').trim().slice(0, 8000) // Gemini limit
    if (!trimmed) throw new Error('embed: empty text')
    return embedWithGemini(tenantId, trimmed)
  },

  /** Encode a vector to JSON for storage. */
  encode(vector: number[]): string {
    return JSON.stringify(vector)
  },

  /** Decode a JSON-stored vector back to a float array. */
  decode(json: string | null | undefined): number[] | null {
    if (!json) return null
    try {
      const arr = JSON.parse(json)
      if (Array.isArray(arr) && arr.every((n) => typeof n === 'number')) {
        return arr as number[]
      }
    } catch {}
    return null
  },

  /** Cosine similarity. Returns -1..1, with 1 = identical direction. */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) {
      const x = a[i]!
      const y = b[i]!
      dot += x * y
      na += x * x
      nb += y * y
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb)
    return denom === 0 ? 0 : dot / denom
  },

  get dimension() {
    return GEMINI_EMBED_DIM
  },
}
