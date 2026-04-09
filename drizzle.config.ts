import type { Config } from 'drizzle-kit'

const host = process.env.DB_HOST ?? '127.0.0.1'
const port = Number(process.env.DB_PORT ?? 2881)
const user = process.env.DB_USER ?? 'root'
const password = process.env.DB_PASSWORD ?? ''
const database = process.env.DB_NAME ?? 'tocr'

// Use URL form because drizzle-kit's per-field validator rejects empty
// passwords, but SeekDB ships with passwordless root by default in dev.
const auth = password ? `${user}:${password}` : user
const url = `mysql://${auth}@${host}:${port}/${database}`

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'mysql',
  dbCredentials: { url },
  verbose: true,
  strict: true,
} satisfies Config
