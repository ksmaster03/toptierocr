import { z } from 'zod'
import { createHmac } from 'node:crypto'

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().default(2881),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('tocr'),

  MASTER_KEY_BASE64: z
    .string()
    .min(1, 'MASTER_KEY_BASE64 is required — see .env.example'),

  /** Optional. If unset we derive a stable secret from MASTER_KEY_BASE64 via HMAC. */
  JWT_SECRET: z.string().optional(),

  DEFAULT_TENANT_ID: z.coerce.number().default(1),

  /** Local disk root for invoice files. Will be created on first write. */
  STORAGE_ROOT: z.string().default('./uploads'),
})

const parsed = EnvSchema.parse(process.env)

const jwtSecret =
  parsed.JWT_SECRET ??
  createHmac('sha256', parsed.MASTER_KEY_BASE64)
    .update('toptier-jwt-secret-v1')
    .digest('hex')

export const env = {
  ...parsed,
  JWT_SECRET: jwtSecret,
}
export type Env = typeof env
