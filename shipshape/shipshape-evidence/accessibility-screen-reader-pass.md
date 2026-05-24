# ShipShape Screen-Reader Pass

Date: 2026-05-24

## Scope

Pages matched to the axe-tested accessibility stretch set: Login, Docs, Document Editor, Projects, Team, and My Week. The pass records unlabeled controls, literal `blank` announcements from the browser accessibility tree, and landmark coverage.

## VoiceOver / NVDA Availability

VoiceOver was attempted from macOS, but this non-interactive shell does not have Accessibility permission for UI scripting (`System Events` reported UI elements access as `false`). NVDA is Windows-only and was not available in this macOS environment.

Because a reliable spoken-output transcript could not be captured, the fallback evidence is a Chrome accessibility-tree pass. This is not a substitute for a human VoiceOver/NVDA run; it records the same classes of issue requested by the feedback against the accessibility tree consumed by screen readers.

## Findings

| Page | Unlabeled Controls | `blank` Announcements | Landmarks | Notes |
|---|---:|---:|---|---|
| Login | 0 | 0 | `main` present | Login is now wrapped in `main#main-content`; no unlabeled controls recorded in the fallback tree. |
| Docs | 0 | 0 | Navigation, complementary sidebar, main, properties aside | App shell landmarks present. |
| Document Editor | 0 | 0 | Navigation, complementary sidebar, main, properties aside | App shell landmarks present. |
| Projects | 0 | 0 | Navigation, complementary sidebar, main, properties aside | App shell landmarks present. |
| Team | 0 | 0 | Navigation, complementary sidebar, main, properties aside | App shell landmarks present. |
| My Week | 0 | 0 | Navigation, complementary sidebar, main, properties aside | App shell landmarks present. |

## Residual Risk

The global accountability banner can be the first announced authenticated-page control and has a long accessible name. It is labeled, but a human VoiceOver/NVDA pass should still confirm reading order and rotor landmark names before treating the screen-reader requirement as closed without caveat.
