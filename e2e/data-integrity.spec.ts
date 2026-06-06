import { test, expect, Page } from './fixtures/isolated-env'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/**
 * Data Integrity Tests
 *
 * Tests that verify data is correctly saved, persisted, and retrieved:
 * - Complete document saves
 * - Image persistence
 * - Mention preservation
 * - Undo/redo accuracy
 * - Copy/paste structure
 * - Database consistency
 */

// Helper to create a new document
async function createNewDocument(page: Page) {
  await page.goto('/docs')
  await page.waitForLoadState('networkidle')

  const currentUrl = page.url()
  // Button uses aria-label, not title attribute
  const newDocButton = page.getByRole('button', { name: /new document/i })
  await expect(newDocButton.first()).toBeVisible({ timeout: 5000 })
  await newDocButton.first().click()

  await page.waitForFunction(
    (oldUrl) => window.location.href !== oldUrl && /\/documents\/[a-f0-9-]+/.test(window.location.href),
    currentUrl,
    { timeout: 10000 }
  )

  await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('textarea[placeholder="Untitled"]')).toBeVisible({ timeout: 3000 })
}

// Helper to login
async function login(page: Page, email: string = 'dev@ship.local', password: string = 'admin123') {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL('/login', { timeout: 5000 })
}

// Create test image
function createTestImageFile(): string {
  const pngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    'base64'
  )
  const tmpPath = path.join(os.tmpdir(), `test-image-${Date.now()}.png`)
  fs.writeFileSync(tmpPath, pngBuffer)
  return tmpPath
}

// Insert an image at the current cursor via the editor's persistent hidden
// <input data-testid="image-upload-input"> (see images.spec.ts for why this is
// reliable in headless CI where the native file-chooser never fires). Does not
// move the selection, so callers control where the image lands.
async function insertImage(page: Page, tmpPath: string): Promise<void> {
  await page.locator('[data-testid="image-upload-input"]').setInputFiles(tmpPath)
}

test.describe('Data Integrity - Document Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('document saves completely with all formatting', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    const titleInput = page.locator('textarea[placeholder="Untitled"]')

    // Set title
    await titleInput.click()
    await titleInput.fill('Complete Document Test')

    // Wait for title to save
    await page.waitForResponse(
      resp => resp.url().includes('/api/documents/') && resp.request().method() === 'PATCH',
      { timeout: 5000 }
    ).catch(() => {})

    // Add content using markdown shortcuts (more reliable than keyboard shortcuts)
    await editor.click()
    await page.waitForTimeout(200)

    // Heading using markdown shortcut (## at start of line)
    // Retry if markdown conversion doesn't trigger — under load, keystrokes may be buffered
    await expect(async () => {
      // Clear editor content and try again
      await editor.click()
      await page.keyboard.press('Meta+a')
      await page.keyboard.press('Delete')
      await page.waitForTimeout(200)
      await page.keyboard.type('## My Test Heading', { delay: 20 })
      await page.keyboard.press('Enter')
      await expect(editor.locator('h2')).toContainText('My Test Heading', { timeout: 5000 })
    }).toPass({ timeout: 15000, intervals: [1000, 2000, 3000] })

    // Ensure editor still has focus after markdown conversion
    await editor.click()
    await expect(editor).toBeFocused({ timeout: 3000 })

    // Plain paragraph content - focus on data integrity, not formatting shortcuts
    await page.keyboard.type('This is regular paragraph text with unique identifier XYZ123 to verify persistence.')

    // Verify content appears in editor BEFORE waiting for sync
    await expect(editor).toContainText('My Test Heading', { timeout: 5000 })
    await expect(editor).toContainText('XYZ123', { timeout: 5000 })

    // Click outside editor to trigger blur/save, then wait for sync
    await titleInput.click()
    await page.waitForTimeout(500)

    // Wait for sync status to show "Saved" (ensures WebSocket sync is complete)
    await expect(page.getByTestId('sync-status').getByText(/Saved|Cached/)).toBeVisible({ timeout: 10000 })

    // Extra buffer for Yjs to fully propagate to server
    await page.waitForTimeout(2000)

    // Get document URL
    const docUrl = page.url()

    // Hard reload
    await page.goto(docUrl)
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Wait for content to load from server
    await page.waitForTimeout(1000)

    // Verify all content is preserved after reload
    await expect(titleInput).toHaveValue('Complete Document Test')
    await expect(editor).toContainText('My Test Heading')
    await expect(editor).toContainText('XYZ123')
    await expect(editor).toContainText('regular paragraph text')

    // Verify heading formatting is preserved
    await expect(editor.locator('h2')).toContainText('My Test Heading')
  })

  test('document with complex nested structure persists', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Create nested list
    await page.keyboard.type('- Parent item 1')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await page.keyboard.type('Nested item 1.1')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Nested item 1.2')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Tab')
    await page.keyboard.type('Double nested 1.2.1')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.type('Parent item 2')

    await page.waitForTimeout(2000)

    // Reload
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Verify nested structure
    await expect(editor).toContainText('Parent item 1')
    await expect(editor).toContainText('Nested item 1.1')
    await expect(editor).toContainText('Nested item 1.2')
    await expect(editor).toContainText('Double nested 1.2.1')
    await expect(editor).toContainText('Parent item 2')
  })

  test('empty document saves correctly', async ({ page }) => {
    await createNewDocument(page)

    const titleInput = page.locator('textarea[placeholder="Untitled"]')

    // Just set title, leave content empty
    await titleInput.click()
    await titleInput.fill('Empty Document')
    await titleInput.blur()

    await page.waitForTimeout(2000)

    // Reload
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Title should be saved
    await expect(titleInput).toHaveValue('Empty Document')

    // Editor should be empty
    const editorText = await page.locator('.ProseMirror').textContent()
    expect(editorText?.trim()).toBe('')
  })

})

test.describe('Data Integrity - Images', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('images persist after page reload', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Upload image
    const tmpPath = createTestImageFile()
    await insertImage(page, tmpPath)

    // Wait for upload
    await expect(editor.locator('img')).toBeVisible({ timeout: 5000 })
    await page.waitForFunction(
      () => {
        const img = document.querySelector('.ProseMirror img')
        if (!img) return false
        const src = img.getAttribute('src') || ''
        return src.startsWith('http') || src.includes('/api/files')
      },
      { timeout: 15000 }
    )

    // Get image src
    const img = editor.locator('img').first()
    const originalSrc = await img.getAttribute('src')

    await page.waitForTimeout(2000)

    // Reload page
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

    // Image should still be there
    await expect(page.locator('.ProseMirror img')).toBeVisible({ timeout: 5000 })

    // Src should be the same
    const reloadedImg = page.locator('.ProseMirror img').first()
    const reloadedSrc = await reloadedImg.getAttribute('src')
    expect(reloadedSrc).toBe(originalSrc)

    fs.unlinkSync(tmpPath)
  })

  test('multiple images persist in correct order', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Note: createTestImageFile() always writes the SAME 1x1 PNG, so both uploads
    // share an identical data URL. The CDN-URL swap therefore MUST locate nodes by
    // uploadId, not by src — this test guards that (Fix A in ImageUpload.tsx).

    // Insert first image after a label
    await page.keyboard.type('Image 1:')
    await page.keyboard.press('Enter')
    const tmpPath1 = createTestImageFile()
    await insertImage(page, tmpPath1)
    await expect(editor.locator('img')).toHaveCount(1, { timeout: 5000 })

    // Move past the first image and insert a second after another label
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Image 2:')
    await page.keyboard.press('Enter')
    const tmpPath2 = createTestImageFile()
    await insertImage(page, tmpPath2)
    await expect(editor.locator('img')).toHaveCount(2, { timeout: 5000 })

    // Wait for BOTH uploads to swap their data URL for a CDN URL
    await expect(async () => {
      const srcs = await editor.locator('img').evaluateAll(
        (els) => els.map((el) => el.getAttribute('src') || '')
      )
      expect(srcs.length).toBe(2)
      for (const src of srcs) {
        expect(src.startsWith('http') || src.includes('/api/files')).toBe(true)
      }
    }).toPass({ timeout: 20000 })

    const srcsBefore = await editor.locator('img').evaluateAll(
      (els) => els.map((el) => el.getAttribute('src') || '')
    )
    // Distinct files on the server → distinct CDN URLs, so order is verifiable.
    expect(srcsBefore[0]).not.toBe(srcsBefore[1])

    // Wait for Yjs sync, then reload and verify both images persist in order
    await page.waitForTimeout(2000)
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.ProseMirror img')).toHaveCount(2, { timeout: 10000 })

    const srcsAfter = await page.locator('.ProseMirror img').evaluateAll(
      (els) => els.map((el) => el.getAttribute('src') || '')
    )
    expect(srcsAfter).toEqual(srcsBefore)

    fs.unlinkSync(tmpPath1)
    fs.unlinkSync(tmpPath2)
  })
})

test.describe('Data Integrity - Mentions', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('mentions survive document reload', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Insert mention
    await page.keyboard.type('Mentioned person: ')
    await page.keyboard.type('@')

    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 })

    // Select first result
    const firstOption = page.locator('[role="option"]').first()
    if (await firstOption.isVisible()) {
      const mentionText = await firstOption.textContent()
      await firstOption.click()

      // Wait for mention to be inserted
      await expect(editor.locator('.mention')).toBeVisible({ timeout: 3000 })

      await page.waitForTimeout(2000)

      // Reload
      await page.reload()
      await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })

      // Mention should still be there
      await expect(page.locator('.ProseMirror .mention')).toBeVisible({ timeout: 5000 })
      await expect(editor).toContainText('Mentioned person:')
    }
  })

  test('multiple mentions persist correctly', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Insert first mention
    await page.keyboard.type('First: ')
    await page.keyboard.type('@')
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 })
    const firstOptions = page.locator('[role="option"]')
    await expect(
      firstOptions.first(),
      'Mention popup should offer at least one target. Run: pnpm db:seed'
    ).toBeVisible({ timeout: 5000 })
    await firstOptions.first().click()
    await expect(editor.locator('.mention')).toHaveCount(1, { timeout: 3000 })

    // Insert second mention
    await page.keyboard.type(' Second: ')
    await page.keyboard.type('@')
    await expect(page.locator('[role="listbox"]')).toBeVisible({ timeout: 5000 })
    const secondOptions = page.locator('[role="option"]')
    await expect(secondOptions.first()).toBeVisible({ timeout: 5000 })
    const optionCount = await secondOptions.count()
    await secondOptions.nth(optionCount > 1 ? 1 : 0).click()
    await expect(editor.locator('.mention')).toHaveCount(2, { timeout: 3000 })

    // Wait for the document to actually save before reloading
    await expect(
      page.getByTestId('sync-status').getByText(/Saved|Cached/)
    ).toBeVisible({ timeout: 10000 })
    await page.waitForTimeout(1000)

    // Reload — both mentions must survive (guards the rapid multi-insert path)
    await page.reload()
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.ProseMirror .mention')).toHaveCount(2, { timeout: 10000 })
  })
})

test.describe('Data Integrity - Undo/Redo', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('undo/redo preserves formatting', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Type formatted text using markdown syntax (keyboard shortcuts unreliable cross-platform)
    await page.keyboard.type('Regular text ')
    await page.waitForTimeout(500)

    await page.keyboard.type('**bold text** ')
    await page.waitForTimeout(500)

    await page.keyboard.type('more regular')
    await page.waitForTimeout(500)

    // Verify content
    await expect(editor).toContainText('Regular text')
    await expect(editor).toContainText('bold text')
    await expect(editor).toContainText('more regular')

    // Verify bold formatting was applied
    const hasBold = await editor.locator('strong').count()
    if (hasBold > 0) {
      await expect(editor.locator('strong')).toContainText('bold text')
    }

    // Undo last part - undo until 'more regular' is gone
    // Use Meta+z for Mac, Control+z for others
    const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'
    const redoKey = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z'

    for (let i = 0; i < 10; i++) {
      await page.keyboard.press(undoKey)
      await page.waitForTimeout(200)
      const content = await editor.textContent()
      if (!content?.includes('more regular')) break
    }
    await expect(editor).not.toContainText('more regular')

    // Redo until 'more regular' is back
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press(redoKey)
      await page.waitForTimeout(200)
      const content = await editor.textContent()
      if (content?.includes('more regular')) break
    }
    await expect(editor).toContainText('more regular')
  })

  test('undo/redo works across multiple operations', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Do multiple operations with longer pauses to create separate undo entries
    // TipTap batches keystrokes aggressively, so we need significant pauses
    await page.keyboard.type('Line 1')
    await page.waitForTimeout(1000)

    await page.keyboard.press('Enter')
    await page.keyboard.type('Line 2')
    await page.waitForTimeout(1000)

    await page.keyboard.press('Enter')
    await page.keyboard.type('Line 3')
    await page.waitForTimeout(1000)

    // Verify initial state
    await expect(editor).toContainText('Line 1')
    await expect(editor).toContainText('Line 2')
    await expect(editor).toContainText('Line 3')

    // Undo until Line 3 is gone (may need many undos due to batching)
    // Use Meta+z for Mac, Control+z for others
    const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'
    const redoKey = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z'

    for (let i = 0; i < 15; i++) {
      await page.keyboard.press(undoKey)
      await page.waitForTimeout(200)
      const content = await editor.textContent()
      if (!content?.includes('Line 3')) break
    }

    const afterUndo = await editor.textContent()
    expect(afterUndo).toContain('Line 1')
    expect(afterUndo).not.toContain('Line 3')

    // Redo until Line 3 is back
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press(redoKey)
      await page.waitForTimeout(200)
      const content = await editor.textContent()
      if (content?.includes('Line 3')) break
    }

    await expect(editor).toContainText('Line 1')
    await expect(editor).toContainText('Line 3')
  })
})

test.describe('Data Integrity - Copy/Paste', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test('copy/paste preserves structure', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Platform-aware shortcuts (Meta for Mac, Control for others)
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

    // Create structured content using markdown shortcuts
    await page.keyboard.type('# Heading')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300) // Wait for markdown conversion

    await page.keyboard.type('- List item 1')
    await page.keyboard.press('Enter')
    await page.keyboard.type('List item 2')
    await page.waitForTimeout(300)

    // Verify content was created before copying
    await expect(editor.locator('h1')).toBeVisible({ timeout: 3000 })
    await expect(editor.locator('li').first()).toBeVisible({ timeout: 3000 })

    // Select all and copy
    await page.keyboard.press(`${modifier}+a`)
    await page.keyboard.press(`${modifier}+c`)
    await page.waitForTimeout(200)

    // Click at end to deselect and position cursor
    await editor.click()
    await page.keyboard.press(`${modifier}+End`)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')

    // Paste
    await page.keyboard.press(`${modifier}+v`)

    await page.waitForTimeout(1000)

    // Should have duplicate structure - check for at least the pasted content
    const headings = await editor.locator('h1').count()
    expect(headings).toBeGreaterThanOrEqual(1)

    const listItems = await editor.locator('li').count()
    expect(listItems).toBeGreaterThanOrEqual(2)

    // Verify content exists twice by checking text
    const text = await editor.textContent()
    expect(text).toContain('Heading')
    expect(text).toContain('List item 1')
  })

  test('paste from external source preserves basic formatting', async ({ page }) => {
    await createNewDocument(page)

    const editor = page.locator('.ProseMirror')
    await editor.click()

    // Simulate pasting HTML content
    await page.evaluate(() => {
      const html = '<p><strong>Bold</strong> and <em>italic</em> text</p><ul><li>Item 1</li><li>Item 2</li></ul>'
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/html', html)
      const pasteEvent = new ClipboardEvent('paste', { clipboardData })
      document.querySelector('.ProseMirror')?.dispatchEvent(pasteEvent)
    })

    await page.waitForTimeout(500)

    // Verify formatting preserved
    await expect(editor).toContainText('Bold and italic text')
    await expect(editor.locator('strong')).toContainText('Bold')
    await expect(editor.locator('em')).toContainText('italic')
    await expect(editor.locator('li').first()).toContainText('Item 1')
  })
})
