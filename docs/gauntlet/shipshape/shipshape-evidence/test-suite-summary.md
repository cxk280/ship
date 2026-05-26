# ShipShape Test Suite Summary

Date: 2026-05-24

Environment: local Postgres on `127.0.0.1:5433`, migrated and seeded with `pnpm db:migrate` and `pnpm db:seed`.

| Run | Command | Result | Files | Tests | Pass/Fail/Skipped | Runtime | Tests That Flipped |
|---:|---|---|---:|---:|---|---:|---|
| 1 | `DATABASE_URL=postgres://ship:ship_dev_password@127.0.0.1:5433/ship_dev pnpm --filter @ship/api test:coverage` | Passed | 29 passed | 465 | 465 passed / 0 failed / 0 skipped | 61.29s | API remains green after final-stretch and Category 8 changes. |
| 2 | `pnpm --filter @ship/web test:coverage` | Passed | 19 passed | 157 | 157 passed / 0 failed / 0 skipped | 28.09s | Previously failing web suites remain green: `document-tabs.test.ts`, `useSessionTimeout.test.ts`, and `DetailsExtension.test.ts`. |
| 3 | `DATABASE_URL=postgres://ship:ship_dev_password@127.0.0.1:5433/ship_dev pnpm test:coverage:changed` | Passed | 48 passed | 622 | 622 passed / 0 failed / 0 skipped | about 89s plus gates | Changed-line gate passed after explicit non-unit evidence exclusions were updated. |
| 4 | `DATABASE_URL=postgres://ship:ship_dev_password@127.0.0.1:5433/ship_dev pnpm test` | Passed | 48 passed | 622 | 622 passed / 0 failed / 0 skipped | API 68.46s + web 28.67s | Root test now runs both API and web suites. |

## Coverage

| Workspace | Statement | Line | Branch | Function |
|---|---:|---:|---:|---:|
| API | 41.07% | 41.25% | 34.27% | 41.41% |
| Web | 27.21% | 28.10% | 16.60% | 22.48% |

Changed-line coverage: `423/423` changed executable unit lines covered (`100.00%`), with explicit exclusions for bootstrap files, type-only compatibility context, security-probe-covered WebSocket/CSP changes, and Playwright axe/accessibility-covered pages.
