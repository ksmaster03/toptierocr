import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import { env } from '../env.ts'
import * as schema from './schema.ts'

// SeekDB is MySQL-wire-compatible on port 2881, so the standard mysql2
// driver works without any modification. The Drizzle MySQL dialect handles
// the SQL generation.

export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  connectionLimit: 5,         // tight cap for t3.micro
  waitForConnections: true,
  enableKeepAlive: true,
})

export const db = drizzle(pool, { schema, mode: 'default' })
export type DB = typeof db
