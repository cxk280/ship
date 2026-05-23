# ShipShape Demo Video Outline

Target length: 3-5 minutes

This is an outline, not proof of a completed video. The final submission should replace this note with the recording URL.

## 0:00-0:30: Project Frame

- ShipShape is an audit and improvement pass on the Treasury Ship TypeScript monorepo.
- The work covers the seven original categories plus the Category 8 Security Audit addendum.
- Emphasize proof: before/after measurements, tests, and checked-in evidence.

## 0:30-1:20: Strongest Audit Findings

- Type safety: API route hotspots were concentrated in `weeks`, `projects`, and `issues`.
- Performance: `team/accountability-grid-v3` and wiki document listing were the highest P95 risks.
- Runtime/accessibility: offline collaboration and ARIA/contrast failures were the most user-visible risks.
- Security: CSP allowed inline scripts and malformed WebSocket messages could crash the API.

## 1:20-2:40: Before/After Proof

- Bundle: initial app chunk reduced from `2,025.10 KiB / 572.07 KiB gzip` to `470.98 kB / 140.68 kB gzip`.
- API: team grid P95 improved from `1,818ms` to `119ms`; wiki summary list P95 measured at `198ms`.
- DB: main-page query count improved from `33` to `25`.
- Type safety: core violations reduced from `1281` to `949` (`25.92%`).
- Tests: API `465/465` and web `157/157` current Vitest suites passed.

## 2:40-3:40: Security Probe

- Show `scripts/security-probe.mjs` and `shipshape/SECURITY_PROBE.md`.
- Show before report: `14` findings, including CSP and WebSocket crash.
- Show after report: `14/16` checks passing, CSP/WebSocket issues closed, remaining dependency/title/content findings documented.
- Explain the two security fixes:
  - CSP nonce for scripts.
  - WebSocket decode try/catch, unsupported-type close, malformed-message close, and error handlers.

## 3:40-4:30: Remaining Risks

- Dependency advisories still need upgrade/override work.
- Title/content sanitization should be hardened at API boundaries.
- A literal VoiceOver/NVDA pass should replace the accessibility-tree fallback.
- Public deployment URL, video URL, and social post URL must be present in the final package.

## 4:30-5:00: Close

- Point to `shipshape/SHIPSHAPE_AUDIT_REPORT.md`, `FIXES_IMPLEMENTATION.md`, `shipshape/DISCOVERIES.md`, `shipshape/SECURITY_PROBE.md`, and `shipshape/GRADING_REVIEW.md`.
