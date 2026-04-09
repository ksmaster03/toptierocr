import { mkdir, writeFile, readFile, unlink, stat } from 'node:fs/promises'
import { join, resolve, basename, extname } from 'node:path'
import { env } from '../env.ts'

/**
 * Local-disk storage for invoice files.
 *
 * Layout: {STORAGE_ROOT}/{tenant_id}/{batch_id}/{invoice_id}_{sanitized}.ext
 *
 * To swap to S3 later, only this file changes — services call
 * storageService.write() / .read() / .relativePath() and never touch fs.
 */

const ROOT = resolve(env.STORAGE_ROOT)

function sanitizeFilename(name: string): string {
  // strip path components, keep only basename, replace anything non-safe
  const base = basename(name)
  return base
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 200)
}

export const storageService = {
  /** Where invoice files live, absolute. */
  rootDir(): string {
    return ROOT
  },

  /**
   * Compute the storage path for a new invoice. Caller persists this string
   * in invoices.storage_path. Path is relative to STORAGE_ROOT so the rows
   * stay portable when STORAGE_ROOT changes.
   */
  buildRelativePath(opts: {
    tenantId: number
    batchId: number
    invoiceId: number
    originalFilename: string
  }): string {
    const safe = sanitizeFilename(opts.originalFilename) || 'file'
    return join(
      String(opts.tenantId),
      String(opts.batchId),
      `${opts.invoiceId}_${safe}`,
    ).replaceAll('\\', '/')
  },

  async write(relativePath: string, data: Uint8Array | Buffer): Promise<void> {
    const abs = join(ROOT, relativePath)
    const dir = abs.substring(0, abs.lastIndexOf('/') > -1 ? abs.lastIndexOf('/') : abs.lastIndexOf('\\'))
    await mkdir(dir, { recursive: true })
    await writeFile(abs, data)
  },

  async read(relativePath: string): Promise<Buffer> {
    const abs = join(ROOT, relativePath)
    return readFile(abs)
  },

  async exists(relativePath: string): Promise<boolean> {
    try {
      await stat(join(ROOT, relativePath))
      return true
    } catch {
      return false
    }
  },

  async delete(relativePath: string): Promise<void> {
    try {
      await unlink(join(ROOT, relativePath))
    } catch {
      /* ignore — best-effort cleanup */
    }
  },
}
