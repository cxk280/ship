import { expect, Page, test } from './fixtures/isolated-env'
import AxeBuilder from '@axe-core/playwright'

const axeTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

async function login(page: Page) {
  await page.goto('/login')

  const setupButton = page.getByRole('button', { name: /create admin account/i })
  const signInButton = page.getByRole('button', { name: 'Sign in', exact: true })
  await expect(setupButton.or(signInButton)).toBeVisible({ timeout: 10000 })

  if (await setupButton.isVisible()) {
    await page.locator('#name').fill('Dev User')
    await page.locator('#email').fill('dev@ship.local')
    await page.locator('#password').fill('admin123')
    await page.locator('#confirmPassword').fill('admin123')
    await setupButton.click()
    await expect(page).not.toHaveURL('/setup', { timeout: 10000 })
    return
  }

  await page.locator('#email').fill('dev@ship.local')
  await page.locator('#password').fill('admin123')
  await signInButton.click()
  await expect(page).not.toHaveURL('/login', { timeout: 10000 })
}

async function expectNoCriticalOrSeriousAxeViolations(page: Page, label: string) {
  await page.waitForLoadState('domcontentloaded')

  const results = await new AxeBuilder({ page })
    .withTags(axeTags)
    .analyze()

  const blockingViolations = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious'
  )

  if (blockingViolations.length > 0) {
    console.log(`${label} critical/serious violations:`, JSON.stringify(blockingViolations, null, 2))
  }

  expect(blockingViolations).toHaveLength(0)
}

test('ShipShape stretch pages have no critical or serious axe violations', async ({ page }) => {
  test.setTimeout(180000)

  await page.goto('/login')
  await expect(page.locator('#email').or(page.getByRole('button', { name: /create admin account/i }))).toBeVisible()
  await expectNoCriticalOrSeriousAxeViolations(page, 'Login')

  await login(page)

  await page.goto('/docs')
  await expect(page.locator('main')).toBeVisible()
  await expectNoCriticalOrSeriousAxeViolations(page, 'Docs')

  const response = await page.request.get('/api/documents?type=wiki&summary=true')
  expect(response.ok()).toBeTruthy()
  const documents = await response.json()
  const document = documents[0]
  expect(document?.id).toBeTruthy()

  await page.goto(`/documents/${document.id}`)
  await expect(page).toHaveURL(/\/documents\/[a-f0-9-]+/, { timeout: 10000 })
  await expect(page.getByPlaceholder('Untitled')).toBeVisible({ timeout: 10000 })
  await expectNoCriticalOrSeriousAxeViolations(page, 'Document Editor')

  await page.goto('/projects')
  await expect(page.locator('main')).toBeVisible()
  await expectNoCriticalOrSeriousAxeViolations(page, 'Projects')

  await page.goto('/team/allocation')
  await expect(page.locator('main')).toBeVisible()
  await expectNoCriticalOrSeriousAxeViolations(page, 'Team')

  await page.goto('/my-week')
  await expect(page.locator('main')).toBeVisible()
  await expectNoCriticalOrSeriousAxeViolations(page, 'My Week')
})
