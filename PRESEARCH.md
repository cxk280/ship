# PRESEARCH — FleetGraph

Decisions made before/while building. Full design + diagram live in [FLEETGRAPH.md](./FLEETGRAPH.md).

## Phase 1 — Define the agent

**1. Agent responsibility scoping**
- *Events monitored proactively:* issue state — stale `in_progress`, overdue (`due_date`), unassigned
  and unestimated open work. (Extensible: sprint confidence vs progress, capacity overload.)
- *Condition worth surfacing:* a deterministic rule fires AND the finding is **novel** (not already
  open/dismissed/snoozed with an unchanged evidence hash). Triage (Tier-1) can further drop noise.
- *Allowed without approval:* record a finding, push an in-app notification, raise a flag, write an
  audit-trail row, answer chat — all additive/reversible.
- *Always requires confirmation:* any mutation of the system of record (issue state/priority/assignee/
  estimate/due_date, plan/retro/approval, sprint confidence, project ICE) and anything that notifies
  another person. Enforced in depth (Zod write surface + `automated_by='fleetgraph'` audit).
- *Knows who's on a project:* `person` docs (`user_id`, `role`, `capacity_hours`, `reports_to`),
  issue `assignee_id`, sprint/project `owner_id`/`accountable_id`, `workspace_memberships.role`.
- *Knows who to notify:* the issue's assignee if set, else workspace admins.
- *On-demand context:* `useCurrentDocument()` → `{documentId, documentType, projectId, sprintId}` →
  `resolveContext` expands to the concrete entity set.

**2. Use cases (≥5):** see the Use Cases table in FLEETGRAPH.md (Engineer/PM/Director across stale,
unassigned, unestimated, overdue, on-demand, and planned confidence/capacity cases).

**3. Trigger model:** **hybrid** — in-process debounced mutation hook (sub-minute on changes) + a
`node-cron` sweep every 5 min (bounded latency on absences), advisory-locked for multi-instance.
Poll-only wastes runs; webhook-only misses "nothing happened" conditions.

## Phase 2 — Graph architecture

**4. Node design:** context (`prepare`, `resolveContext`) → 4 parallel read-only fetch nodes →
`merge` → deterministic `detect`/`dedup` → Tier-1 `triage` → Tier-2 `reason` → `classify` →
`surfaceAuto` → `humanGate` (interrupt) → `executeApproved`/`recordDismiss`/`recordSnooze`. On-demand
branches at `merge` to `answerNode` → `respond`. Conditional edges at: mode, dedup novelty, triage
severity, autonomy, and the resume decision. (Diagram + edge table in FLEETGRAPH.md.)

**5. State management:** `raw` caches fetches within a run; `fleetgraph_findings` is the cross-run
dedup memory; the Postgres checkpoint holds paused-run state; `fleetgraph_pending_approvals` projects
it into the inbox. Redundant API/LLM calls avoided by dedup-before-LLM and `raw` caching.

**6. Human-in-the-loop:** `interrupt()` at `humanGate` with a Postgres checkpointer; the inbox shows an
approval card (Approve / Snooze 7d / Dismiss). Approve → PATCH + audit; dismiss → permanent suppress;
snooze → re-surfaces after `snooze_until`.

**7. Error/failure handling:** every LLM call is best-effort — on Bedrock failure the graph falls back
to deterministic triage/templated findings/“model unavailable” chat, so detection never hard-fails.
DB reads are bounded (LIMITs); the mutation hook is fire-and-forget and never blocks the request.

## Phase 3 — Stack & deployment

**8. Deployment:** runs inside Ship's Express service on Elastic Beanstalk; no separate worker. Cron +
debounced queue live in-process. Authenticates without a user session via Bearer API token (or, in
process, the shared DB pool). Bedrock uses the EB instance role — no key.

**9. Performance:** mutation path lands ≪ 5 min (typically < 1 min); cron interval is the latency for
absence-class conditions. Token budget: quiet = 0, autonomous ≈ 1–3k T1 + 2–5k T2, on-demand ≈ 3–9k
T2. Cost cliffs (fan-out fetch, per-signal LLM, re-reasoning) are mitigated by scoping, batching, and
dedup-before-LLM.
