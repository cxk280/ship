# Edge Cases — Findings & Remediation

**Scope:** the FleetGraph agent surface — `api/src/fleetgraph/**` and `api/src/routes/fleetgraph.ts`.
**Date:** 2026-05-27.

## Surface map

- **Entry points (trust boundaries):**
  - `POST /api/fleetgraph/chat` — untrusted `message` + scope (`documentId`/`documentType`/`projectId`/`sprintId`). Feeds an LLM that can propose a state-changing action.
  - `POST /api/fleetgraph/approvals/:threadId/resume` — human decision on a paused HITL run (state-changing).
  - `POST /api/fleetgraph/findings/:id/resolve` — manual dismiss/snooze of an autonomous finding.
  - `GET /api/fleetgraph/inbox` — read-only projection.
  - `enqueueMutationRun` (issue PATCH/POST hook) + node-cron `sweep`/`digestSweep` — internal triggers; issue/title/description content flows into LLM prompts.
- **Sinks:** LLM prompts (prompt-injection surface); `executeApproved` writes to `documents.properties` (the only mutation sink, parameterized SQL + `FOR UPDATE`, audit row `automated_by='fleetgraph'`); `fleetgraph_findings` / `fleetgraph_pending_approvals` rows; WebSocket `broadcastToUser`.
- **External deps:** PostgreSQL (`pg` pool), Anthropic/Bedrock LLM (best-effort, callers fall back deterministically), LangGraph PostgresSaver checkpointer.
- **Trust model:** all reads/writes are workspace-scoped via `workspace_id`; the autonomy backstop is that LLM-originated mutations only reach the DB through the HITL approval gate and only touch 5 whitelisted fields.

**Categories walked** (taxonomy): 1 input validation · 2 numeric/boundary · 3 state/idempotency · 4 concurrency/timing · 5 resource limits · 6 error handling · 7 security · 8 time/date · 9 collections/integrity · 10 config/env · 11 UI/client. All considered against the surface above.

## Findings (sorted: critical → low)

### EC-1 — Cross-tenant person lookup in `fetchPersonUserId`  [severity: medium | likelihood: low]
- **Category:** 7 (AuthZ / IDOR), trust-boundary.
- **Location:** `api/src/fleetgraph/fetch.ts` `fetchPersonUserId`; reached from `graph.ts` `resolveContext` via chat scope `{documentType:'person', documentId}`.
- **Trigger:** chat request with `documentType:'person'` and a `documentId` belonging to a **different** workspace.
- **Impact:** the query had no `workspace_id` predicate, so it read a person doc from any tenant and resolved its `user_id`. Issues are still workspace-filtered downstream, so no row data leaked — but it is a cross-tenant object reference that should never resolve.
- **Remediation:** added `workspace_id = $2` to the query; threaded `state.workspaceId` from `resolveContext`. (`fetch.ts`, `graph.ts`.)
- **Status:** fixed.
- **Verified:** integration test `fetchPersonUserId is workspace-scoped` — same-ws resolves the user, a different ws id returns `null`.

### EC-2 — Chat action payloads not validated against enum/format/bounds  [severity: medium | likelihood: medium]
- **Category:** 1 (input validation) / 7 (untrusted LLM output → write).
- **Location:** `api/src/fleetgraph/graph.ts` `answer` node (old inline `payloadOk`).
- **Trigger:** the LLM — steered by an untrusted issue title or the user's message — emits an action like `set_state {state:"shipped"}`, `set_priority {priority:"CRITICAL"}`, `set_due_date {due_date:"whenever"}`, or `set_estimate {estimate:-5 / 1e9}`. The old check only asserted `typeof === 'string'` / `Number.isFinite`, so the value passed the gate and, once a human approved, was written verbatim into `documents.properties` — corrupting board/state rendering with an unknown enum value.
- **Impact:** data-integrity corruption of an issue's `state`/`priority`/`due_date`/`estimate`. Human-gated, so not a silent write, but the approval summary doesn't make a bad enum obvious.
- **Remediation:** extracted a pure, exported `isValidChatActionPayload(kind, payload, validAssigneeIds)` enforcing the state/priority enums, a strict `YYYY-MM-DD` calendar-valid date (round-trip rejects `2026-02-30`/`2026-13-01`), and `0 ≤ estimate ≤ 10000`; `reassign` still constrained to known team user ids. (`graph.ts`.)
- **Status:** fixed.
- **Verified:** unit test `chat-action-validation.test.ts` (enums, negative/huge/NaN/Infinity estimate, rolled-over dates, unknown kinds).

### EC-3 — Double-submit / TOCTOU on approval resume double-applies the mutation  [severity: medium | likelihood: medium]
- **Category:** 3 (idempotency / double action) / 4 (TOCTOU).
- **Location:** `api/src/routes/fleetgraph.ts` resume route; `findings-store.ts`.
- **Trigger:** two near-simultaneous `POST /approvals/:threadId/resume` (double-click, retry). Both read `status='pending'`, both pass the 409 check, both resume the graph → the mutation applies twice (duplicate `document_history` audit row + duplicate notify, and a second `Command resume` on a completed thread).
- **Impact:** duplicate audit rows / notifications; ambiguous double-execution of a state change.
- **Remediation:** added an atomic claim — `claimPendingApproval` flips `pending → processing` in a single conditional `UPDATE ... RETURNING`; the route resumes only if it won the claim, else returns 409. On graph error the claim is released (`revertPendingApprovalClaim`) so the human can retry; on success the graph sets the terminal status. The `processing` row also drops out of the inbox while in flight. (`routes/fleetgraph.ts`, `findings-store.ts`.)
- **Status:** fixed.
- **Verified:** integration test `claimPendingApproval is atomic` — first claim true, second false, revert re-enables, wrong-workspace claim false.

### EC-4 — Non-UUID `:id` on `/findings/:id/resolve` returns 500  [severity: low | likelihood: low]
- **Category:** 1 (input validation) / 6 (error leakage).
- **Location:** `api/src/routes/fleetgraph.ts` finding-resolve route.
- **Trigger:** `POST /api/fleetgraph/findings/not-a-uuid/resolve`. The value hit a `uuid` column → Postgres `invalid input syntax for type uuid` → caught as a 500.
- **Impact:** wrong status code (500 vs 404); a malformed id is a client error, not a server error.
- **Remediation:** validate the id with `z.string().uuid()` up front and return 404 when it isn't a UUID. (`routes/fleetgraph.ts`.)
- **Status:** fixed.
- **Verified:** type-check; reviewed against the schema (`fleetgraph_findings.id UUID`). (Route-level; no integration test added — covered by the validation guard.)

### EC-5 — `fetchTeam` had no row limit  [severity: low | likelihood: low]
- **Category:** 5 (resource limits / unbounded result into a prompt).
- **Location:** `api/src/fleetgraph/fetch.ts` `fetchTeam`.
- **Trigger:** a workspace with a very large number of `person` documents.
- **Impact:** the whole team is serialized into the LLM prompt (`answer`/digest), so an unbounded person count means an unbounded prompt (cost / truncation). Sibling fetches were already capped (issues 500, projects 100, weeks 50, docIndex 200).
- **Remediation:** added `LIMIT 200`, matching the doc-index cap. (`fetch.ts`.)
- **Status:** fixed.
- **Verified:** type-check; existing team-dependent tests still pass.

## Dropped candidates (false positives / accepted)

- **Prompt injection → autonomous mutation:** considered top-priority. Mitigated by design — the proactive path never lets the LLM originate an action (`triage` returns indices, `reason` only rewrites title/detail; actions come from deterministic detectors with fixed payloads). In chat, any LLM-proposed action is bounded to one validated issue id in scope + (now) enum/format-checked payload, and **must pass the HITL gate**. Covered by the Layer-4 adversarial eval set. Not a code change.
- **IDOR on `/findings/:id/resolve` and resume across workspaces:** both are workspace-scoped (`WHERE workspace_id=$1`; resume re-checks `pending.workspace_id === req.workspaceId`). Within a workspace, findings/approvals are intentionally shared; the approver is recorded in `document_history`. Accepted.
- **SQL injection:** all queries are parameterized (`pg` `$n`), including the `ANY($n::uuid[])` scope clauses. No string-built SQL. Not a finding.
- **`executeApproved` writing outside the 5 allowed fields:** structurally bounded by `FIELD_BY_KIND`; the existing Layer-2 backstop test asserts the boundary. Not a finding.
- **Stuck `processing` approval after the EC-3 fix:** handled — the route reverts the claim on graph error, and the graph sets a terminal status on success, so there is no permanent limbo.
- **`set_state:'done'/'cancelled'` via chat:** legitimate, human-approved transition; not an edge case.
