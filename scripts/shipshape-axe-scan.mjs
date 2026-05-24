import { chromium } from "@playwright/test";
import AxeBuilder from '@axe-core/playwright';

const BASE = process.env.AXE_BASE || 'http://localhost:5173';
const axeTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const pages = [
  ['Login', '/login'],
  ['Docs', '/docs'],
  ['Projects', '/projects'],
  ['Team', '/team/allocation'],
  ['My Week', '/my-week'],
];

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

async function scan(label) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(800);
  const results = await new AxeBuilder({ page }).withTags(axeTags).analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious'
  );
  console.log(`\n=== ${label} (${page.url()}) ===`);
  console.log(`  critical/serious violations: ${blocking.length}`);
  for (const v of blocking) {
    console.log(`  - [${v.impact}] ${v.id}: ${v.help} (nodes: ${v.nodes.length})`);
    for (const n of v.nodes.slice(0, 3)) {
      console.log(`      ${n.target.join(' ')}`);
    }
  }
  return blocking.length;
}

// Login page (pre-auth)
await page.goto(`${BASE}/login`);
await page.waitForSelector('#email, button:has-text("Create admin account")', { timeout: 15000 });
let total = 0;
total += await scan('Login');

// Authenticate
await page.fill('#email', 'dev@ship.local');
await page.fill('#password', 'admin123');
await page.click('button:has-text("Sign in")');
await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 15000 });
// Dismiss action items modal if present
const gotIt = page.getByRole('button', { name: 'Got it' });
if (await gotIt.isVisible().catch(() => false)) await gotIt.click().catch(() => {});

for (const [label, path] of pages.slice(1)) {
  await page.goto(`${BASE}${path}`);
  await page.waitForSelector('main', { timeout: 15000 }).catch(() => {});
  // close modal if it reappears
  const g = page.getByRole('button', { name: 'Got it' });
  if (await g.isVisible().catch(() => false)) await g.click().catch(() => {});
  total += await scan(label);
}

console.log(`\nTOTAL critical/serious across pages: ${total}`);
await browser.close();
process.exit(total > 0 ? 2 : 0);
