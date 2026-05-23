# Social Post Draft

This is a draft, not proof of publication. The final submission should include the public X or LinkedIn URL.

## Draft

I audited and improved Treasury's Ship TypeScript monorepo for @GauntletAI Week 4.

Highlights:

- Built measured baselines across type safety, bundle size, API latency, DB query efficiency, tests, runtime edge cases, accessibility, and security.
- Reduced the main app bundle from `2,025 KiB` to `471 kB`.
- Improved team-grid P95 latency from `1,818ms` to `119ms`.
- Reduced main-page SQL calls from `33` to `25`.
- Added a runnable security probe covering auth/session, WebSockets, input sanitization, dependencies, CSP/CORS, and manual-review surfaces.
- Closed CSP inline-script exposure and a malformed WebSocket crash with before/after proof.

The most valuable lesson: measurement quality matters as much as code changes. The credible fixes were the ones backed by repeatable commands, raw evidence, and honest caveats.

#GovTech #TypeScript #Accessibility #Security #Performance
