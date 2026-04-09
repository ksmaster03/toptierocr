import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * E2E happy path through the Toptier AI OCR app.
 *
 * Pre-requisites:
 *   - `bun run dev` running on http://localhost:3737
 *   - SeekDB Docker container up
 *   - admin/demo seed users present
 */

// Tiny valid 1×1 PNG so the upload route accepts it. We don't run real OCR
// here — Step 2 wiring is verified by integration tests; the goal of e2e is
// to prove the browser flow itself works.
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x5a, 0xfa, 0x88, 0xf7, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])
const FIXTURE_PATH = path.join(__dirname, 'fixture.png')
fs.writeFileSync(FIXTURE_PATH, TINY_PNG)

test.describe('Toptier AI OCR — happy path', () => {
  test('login overlay is the only thing visible before auth', async ({ page }) => {
    await page.goto('/')
    // Body should have pre-auth class → app shell hidden
    await expect(page.locator('body')).toHaveClass(/pre-auth/)
    await expect(page.locator('#login-overlay')).toBeVisible()
    await expect(page.locator('header')).toBeHidden()
    // Logo / title in login card
    await expect(page.getByRole('heading', { name: /Toptier AI OCR/i })).toBeVisible()
  })

  test('rejects invalid credentials', async ({ page }) => {
    await page.goto('/')
    await page.locator('#lg-user').fill('admin')
    await page.locator('#lg-pass').fill('wrong-password')
    await page.locator('#lg-btn').click()
    await expect(page.locator('#lg-err')).toBeVisible()
    // Body still in pre-auth — login screen still up
    await expect(page.locator('body')).toHaveClass(/pre-auth/)
  })

  test('admin login → app shell appears, Admin button is visible', async ({ page }) => {
    await page.goto('/')
    await page.locator('#lg-user').fill('admin')
    await page.locator('#lg-pass').fill('admin123')
    await page.locator('#lg-btn').click()

    // Wait for body to lose pre-auth class
    await expect(page.locator('body')).not.toHaveClass(/pre-auth/)
    await expect(page.locator('header')).toBeVisible()
    // User pill shows admin
    await expect(page.locator('#hdr-user')).toContainText('admin', { ignoreCase: true })
    // Admin button visible (shows for admin only)
    await expect(page.locator('#hdr-settings')).toBeVisible()
  })

  test('demo login → Admin button is hidden', async ({ page }) => {
    await page.goto('/')
    await page.locator('#lg-user').fill('demo')
    await page.locator('#lg-pass').fill('demo123')
    await page.locator('#lg-btn').click()
    await expect(page.locator('body')).not.toHaveClass(/pre-auth/)
    await expect(page.locator('#hdr-settings')).toBeHidden()
    await expect(page.locator('#hdr-user')).toContainText(/demo/i)
  })

  test('upload mode toggle switches between Single and Bulk panels', async ({ page }) => {
    await page.goto('/')
    await page.locator('#lg-user').fill('admin')
    await page.locator('#lg-pass').fill('admin123')
    await page.locator('#lg-btn').click()
    await expect(page.locator('body')).not.toHaveClass(/pre-auth/)

    // Default is Single (manual rows visible)
    await expect(page.locator('#upload-mode-manual')).toBeVisible()
    await expect(page.locator('#upload-mode-bulk')).toBeHidden()

    // Click Bulk radio
    await page.locator('input[name="upload-mode"][value="bulk"]').check()
    await expect(page.locator('#upload-mode-bulk')).toBeVisible()
    await expect(page.locator('#upload-mode-manual')).toBeHidden()
    // Bulk dropzone is present
    await expect(page.locator('#bulk-dropzone')).toBeVisible()

    // Back to Single
    await page.locator('input[name="upload-mode"][value="manual"]').check()
    await expect(page.locator('#upload-mode-manual')).toBeVisible()
    await expect(page.locator('#upload-mode-bulk')).toBeHidden()
  })

  test('Bulk Upload → file selected → Start OCR creates a batch and goes to Step 2', async ({ page }) => {
    await page.goto('/')
    await page.locator('#lg-user').fill('admin')
    await page.locator('#lg-pass').fill('admin123')
    await page.locator('#lg-btn').click()
    await expect(page.locator('body')).not.toHaveClass(/pre-auth/)

    // Wait for Step 1 init to populate doc types into the bulk select.
    await expect(page.locator('#bulk-type-select option').first()).toBeAttached({ timeout: 10_000 })

    // Switch to Bulk mode (its file input has a stable id and isn't re-rendered)
    await page.locator('input[name="upload-mode"][value="bulk"]').check()
    await expect(page.locator('#upload-mode-bulk')).toBeVisible()

    // Attach a file via the hidden bulk-file-input (Playwright handles hidden inputs)
    await page.locator('#bulk-file-input').setInputFiles(FIXTURE_PATH)

    // After file selected, ALL .ocr-go-btn instances become enabled
    const startBtns = page.locator('.ocr-go-btn')
    await expect(startBtns.first()).toBeEnabled({ timeout: 5_000 })

    // Click the top Start button
    await startBtns.first().click()

    // App navigates to Step 2 and shows the batch header
    await expect(page.locator('#s2-batch-name')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('#s2-batch-name')).toContainText(/^BATCH-\d{8}-\d{3}$/)
    // Queue should list our file
    await expect(page.locator('#s2-queue')).toContainText('fixture.png')
  })

  test('Settings modal opens for admin and shows 3 tabs', async ({ page }) => {
    await page.goto('/')
    await page.locator('#lg-user').fill('admin')
    await page.locator('#lg-pass').fill('admin123')
    await page.locator('#lg-btn').click()
    await expect(page.locator('body')).not.toHaveClass(/pre-auth/)

    await page.locator('#hdr-settings').click()
    await expect(page.locator('#settings-modal')).toBeVisible()
    // 3 tab buttons
    await expect(page.locator('.cfg-tab[data-tab="ai"]')).toBeVisible()
    await expect(page.locator('.cfg-tab[data-tab="doctype"]')).toBeVisible()
    await expect(page.locator('.cfg-tab[data-tab="cost"]')).toBeVisible()
    // AI tab content visible by default
    await expect(page.locator('#cfg-tab-ai')).toBeVisible()

    // Switch to doctype tab
    await page.locator('.cfg-tab[data-tab="doctype"]').click()
    await expect(page.locator('#cfg-tab-doctype')).toBeVisible()
    await expect(page.locator('#cfg-tab-ai')).toBeHidden()
  })

  test('Logout returns to login overlay', async ({ page }) => {
    await page.goto('/')
    await page.locator('#lg-user').fill('admin')
    await page.locator('#lg-pass').fill('admin123')
    await page.locator('#lg-btn').click()
    await expect(page.locator('body')).not.toHaveClass(/pre-auth/)

    // Logout button (the one in the header, not the one in the modal)
    await page.locator('header button:has-text("ออกจากระบบ")').click()
    await expect(page.locator('body')).toHaveClass(/pre-auth/)
    await expect(page.locator('#login-overlay')).toBeVisible()
  })
})
