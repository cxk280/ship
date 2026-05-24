# ShipShape Demo Video Outline

Target length: 3-5 minutes

This is an outline, not proof of a completed video. The final submission should replace this note with the recording URL.

## 0:00-0:30: Project Frame

- ShipShape is an audit-and-improvement pass on the U.S. Treasury `ship` TypeScript monorepo.
- The work covers the seven original categories plus the **Category 8 Security Audit** (the Security Audit PDF takes precedence, so this is an 8-category submission).
- Theme: **proof over promises** — every claim is backed by a reproducible script, a test, or a live before/after.

## 0:30-1:20: Strongest Audit Findings (the diagnosis)

- Type safety: API route hotspots concentrated in `weeks.ts`, `projects.ts`, `issues.ts` (auth/row-shape casts).
- Performance: `team/accountability-grid-v3` and the wiki document list were the highest P95 risks.
- Runtime/accessibility: offline collaboration recovery and ARIA/contrast failures were the most user-visible risks.
- Security: CSP allowed inline scripts, and malformed WebSocket messages could crash the API.

## 1:20-2:30: Before/After Proof (the treatment)

- **Bundle:** initial app chunk `2,025.10 KiB / 572.07 KiB gz` → `328.43 kB / 94.85 kB gz`; the old `PropertyRow` warning chunk `836 kB` → `85.72 kB`; build emits **no chunk-size warnings**.
- **API:** `team/accountability-grid-v3` P95 `1,818ms` → `119ms` (same-endpoint before/after under identical seed + concurrency). Wiki document list now served in `198ms` P95 via summary mode for list views.
- **DB:** audited main-page flow `33` → `25` queries; migration `038` adds targeted indexes.
- **Type safety:** core violations `1281` → `950` (**25.84%**), reproducible live in the video with `npx tsx scripts/shipshape-type-violations.ts`.
- **Tests:** API `465/465` and web `157/157` Vitest suites pass.

## 2:30-3:30: Security Probe (Category 8)

- Run it live, one command: `node scripts/security-probe.mjs --base-url http://127.0.0.1:3000`.
- Four attack surfaces: auth/session, WebSocket validation, input sanitization (stored + reflected), dependency `audit`.
- Result: **14/16 checks pass, 0 Critical/High, 0 dependency findings**; show the verified fixes:
  - **CSP** — `script-src` is now nonce-only (no `unsafe-inline`); the admin page threads the nonce through its inline script.
  - **WebSocket** — decode wrapped in try/catch, unsupported types → close 1003, malformed → close without crashing the process; all 4 WebSocket checks now pass.
  - **Dependencies** — pinned `pnpm.overrides` closed the critical `fast-xml-parser` advisory + 9 highs (`hono`, `@hono/node-server`, `express-rate-limit`, `fast-uri`, `path-to-regexp`); `pnpm audit --prod` now shows 0 high/critical.
- The only remaining probe findings are 2 medium stored-input notes, verified mitigated at output (React/TipTap + audited `escapeHtml` in the two manual `innerHTML` widgets).

## 3:30-4:20: Final Adversarial Re-grade (what was caught and fixed)

Walk through `shipshape/CLAUDE_FINAL_AUDIT.md` — an independent strict-grader pass that caught real defects:

- **Accessibility ARIA regression:** a removed `role="tree"`/`treeitem` change had broken `e2e/accessibility-remediation.spec.ts`; the ARIA was restored. Show `/docs` with `aria-selected` on the active item.
- **False "0 violations" claim corrected:** a live `axe` scan still showed serious contrast failures on Projects (12 nodes) and My Week (4 nodes); fixed with AA-safe colors. Run `node scripts/shipshape-axe-scan.mjs` live → **all 6 target pages 0 critical/serious**.
- **CSP/Google-Fonts** defect on the deployed app fixed in `api/src/app.ts`.
- Show the deployed app on Railway running in **`NODE_ENV=production`** (secure cookies, hardened errors), login working.

## 4:20-5:00: Remaining Risks + Close

- All high/critical dependency advisories are now resolved via `pnpm.overrides`; 6 moderate + 1 low remain on editor/websocket/express paths (below the probe's gating threshold) and can be revisited as those upstreams release patches. A literal VoiceOver/NVDA pass should supplement the axe + accessibility-tree evidence.
- Point to: `shipshape/CLAUDE_FINAL_AUDIT.md`, `shipshape/SHIPSHAPE_AUDIT_REPORT.md`, `FIXES_IMPLEMENTATION.md`, `shipshape/DISCOVERIES.md`, `shipshape/SECURITY_PROBE.md`, and the reproducible scripts under `scripts/`.
- Deployed app: `https://shipshape-app-production-7ed8.up.railway.app` (login `dev@ship.local` / `admin123`).
