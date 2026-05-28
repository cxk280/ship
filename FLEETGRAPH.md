# FleetGraph

A project-intelligence agent embedded in **Ship**. It reads the live state of a project, reasons
about what's wrong and what's next, and acts — **proactively** (pushes findings with no user present)
and **on-demand** (context-aware chat scoped to the view you're looking at). Both modes run through
**one LangGraph.js graph**; the only difference is the trigger.

- **Framework:** LangGraph.js (`@langchain/langgraph`) running inside Ship's Express API (`api/src/fleetgraph/`).
- **Model:** Claude, tiered — Tier-1 Haiku (triage) + Tier-2 Sonnet/Opus (reason, answer). The
  provider auto-switches at runtime (`llm.ts`): the **Anthropic API** (`claude-sonnet-4-6` /
  `claude-haiku-4-5`) when `ANTHROPIC_API_KEY` is set — the prod/Railway path — otherwise **AWS
  Bedrock** (Opus/Haiku), reusing Ship's IAM instance role with no new key (the EB path).
- **Observability:** LangSmith tracing (auto via LangGraph when `LANGCHAIN_TRACING_V2=true`).
- **Persistence:** Postgres-backed checkpointer (`@langchain/langgraph-checkpoint-postgres`) so
  interrupted human-in-the-loop runs survive deploys/scale-in; one `fleetgraph_findings` table is the
  cross-run dedup memory; `fleetgraph_pending_approvals` projects paused runs into the inbox.

---

## Agent Responsibility

**What it monitors proactively.** Issue state across the workspace's open work. Today's detectors
(`api/src/fleetgraph/detectors.ts`) flag:
- **Stale in-progress** — `state=in_progress` with no activity (no `document_history` row / `updated_at`)
  for ≥ N days (`FLEETGRAPH_STALE_DAYS`, default 3).
- **Overdue** — `due_date < today` and not `done`/`cancelled`.
- **Unassigned** — open work (`todo`/`in_progress`/`in_review`) with no `assignee_id`.
- **Unestimated** — open work with no `estimate`.

**What it reasons about on demand.** Whatever the user is looking at — an issue, sprint, project,
program, or person — scoped to that document's work. The embedded chat answers questions ("What's at
risk here?", "Who's overloaded?", "Is this week on track?") grounded in the fetched state, and can
suggest the next action. Because **everything in Ship is a document**, it also answers
workspace-landscape questions from a document census + index ("how many documents/issues are there?",
"list the wikis", "what projects exist?", "who's on the team?").

**What it can do autonomously (no approval).** Additive, reversible things only: record a finding,
push an in-app notification, surface a flag in the inbox, write a `document_history` audit row, and
answer chat questions. These never change the system of record.

**What always requires human approval (HITL).** Any mutation of authoritative project state:
issue `state` / `priority` / `assignee_id` / `estimate` / `due_date`, plan/retro/approval edits,
sprint `confidence`, project ICE — and anything that would notify another person (reassignment,
escalation). The gate is enforced in depth: the agent's write path only ever touches Ship's
Zod-validated fields, and every write it makes is stamped `automated_by='fleetgraph'` for instant
audit and rollback. Current HITL actions: **move stalled work back to To Do** and **raise an overdue
issue to Urgent** — both proposed, never applied without a click.

**Who it notifies, and when.** Findings/approvals are pushed over Ship's existing `/events`
WebSocket (`broadcastToUser`) to the issue's **assignee** when set; otherwise to **workspace admins**
as a fallback. Notifications fire only for *novel* findings (see dedup), so the agent stays quiet
when nothing has materially changed.

**How it knows who is on a project / their role.** From Ship's real model: `person` documents
(`properties.user_id`, `role`, `capacity_hours`, `reports_to`), the `assignee_id` on issues, sprint
`owner_id`, project `owner_id`/`accountable_id` (RACI), and `workspace_memberships.role`
(`admin`/`member`). The agent authenticates with no user session via a Bearer API token when needed;
in-process it queries the same DB pool directly.

**How on-demand mode uses the current view.** The chat reads `useCurrentDocument()` on the client
and passes `{ documentId, documentType, projectId, sprintId }` to the graph. `resolveContext` expands
that into the concrete entity set by document type — issue → that issue; sprint / project / program →
that container's issues; person → that user's assigned work. A workspace-wide document **census**
(counts by type) and **index** (title + type directory) are always fetched too, so the chat can answer
landscape questions regardless of the current view.

---

## Graph Diagram

One graph, both modes. Node names match `api/src/fleetgraph/graph.ts`.

```mermaid
flowchart TD
  START([Trigger]) --> P[prepare<br/>load known findings + admins]
  P -->|mode = ondemand| RC[resolveContext]
  P -->|mode = proactive| D[dispatch]
  RC --> D

  D --> FI[fetchIssues]
  D --> FW[fetchWeeks]
  D --> FT[fetchTeam]
  D --> FP[fetchProjects]
  D --> FM[fetchMeta<br/>sprint window + progress]
  FI --> M[(merge · raw shallow-merge)]
  FW --> M
  FT --> M
  FP --> M
  FM --> M

  M -->|triggerKind = digest| DG[digest · Tier2 per-project synthesis]
  M -->|ondemand| AN[answerNode · Tier2 · may propose an action]
  M -->|proactive| DET[detectSignals + sprintSlip + capacity]
  DG --> SA
  AN -->|read-only| RSP[respond] --> E0([END · chat answer])
  AN -->|proposes write| HG

  DET --> DD[dedupFilter<br/>+ adaptive suppression by dismissals]
  DD -->|novel = 0| E1([END · quiet · no LLM])
  DD -->|novel > 0| TR[triage · Tier1]
  TR -->|kept = 0| E2([END · stay quiet])
  TR -->|kept > 0| RE[reason · Tier2]
  RE --> CL[classify]
  CL --> SA[surfaceAuto<br/>record + notify auto findings]
  SA -->|no HITL action| E3([END · autonomous])
  SA -->|has HITL action| HG{{humanGate · INTERRUPT<br/>PostgresSaver checkpoint}}
  HG -->|approve| EX[executeApproved · PATCH + audit] --> E4([END · acted])
  HG -->|dismiss| RDis[recordDismiss · suppress] --> E5([END])
  HG -->|snooze| RSnz[recordSnooze · snooze_until] --> E6([END])
```

> **Evals (4 layers, all gate CI):** `pnpm fleetgraph:eval` scores the deterministic detectors +
> dedup/suppression (precision / recall / quiet-accuracy; 17 detector + 10 dedup cases).
> `pnpm fleetgraph:eval:llm` runs the LLM-graded layers — triage, reasoning faithfulness, chat
> groundedness, action-extraction, **adversarial/prompt-injection**, and a ~48-case **meta/landscape**
> suite (document counts, distributions, ownership, naming/listing docs of any type). Layer 2
> (graph-path + HITL integration) runs under vitest against a real DB. CircleCI runs all layers and
> auto-deploys to Railway on a green `master`. See `api/src/fleetgraph/evals/`.

### Node types
- **Context:** `prepare` (load dedup baseline + admins), `resolveContext` (on-demand scope expansion).
- **Fetch (parallel, read-only):** `fetchIssues`, `fetchWeeks`, `fetchTeam`, `fetchProjects`,
  `fetchMeta` (sprint window/progress + workspace document **census** & title/type **index**) → `merge`
  (the `raw` channel shallow-merges the fetches, so fan-in is order-independent).
- **Reasoning:** `detectSignals` (deterministic), `dedupFilter` (deterministic), `triage` (Tier-1 Haiku),
  `reason` (Tier-2 Opus), `answerNode` (Tier-2, on-demand).
- **Action:** `classify` (auto vs HITL policy), `surfaceAuto` (persist + notify autonomous findings),
  `humanGate` (`interrupt()`), `executeApproved`, `recordDismiss`, `recordSnooze`.
- **Output:** `respond` (chat), plus the notify/persist side-effects in `surfaceAuto`/`executeApproved`.

### Edges & branching conditions
| From | Condition | To |
|---|---|---|
| `prepare` | `mode === 'ondemand'` | `resolveContext` → `dispatch` |
| `prepare` | `mode === 'proactive'` | `dispatch` |
| `merge` | `mode === 'ondemand'` | `answerNode` → `respond` → END |
| `merge` | `mode === 'proactive'` | `detectSignals` |
| `dedupFilter` | `novelSignals.length === 0` | END (quiet, **no LLM**) |
| `dedupFilter` | `novelSignals.length > 0` | `triage` |
| `triage` | `keptSignals.length === 0` | END (stay quiet) |
| `triage` | `keptSignals.length > 0` | `reason` → `classify` → `surfaceAuto` |
| `surfaceAuto` | no HITL action | END (autonomous) |
| `surfaceAuto` | has HITL action | `humanGate` (interrupt) |
| `humanGate` | resume `approve` | `executeApproved` |
| `humanGate` | resume `dismiss` | `recordDismiss` |
| `humanGate` | resume `snooze` | `recordSnooze` |

### Distinct execution paths (for LangSmith trace evidence)
1. **Quiet** — proactive, dedup short-circuits → ends before any LLM call.
2. **Stay-quiet** — triage drops everything (Tier-1 only).
3. **Autonomous finding** — Tier-1 + Tier-2, posts + notifies, no interrupt.
4. **HITL approve** — pauses at `humanGate`, resumes, applies a PATCH.
5. **HITL dismiss / snooze** — pauses, resumes without mutating.
6. **On-demand read** — router → fetch → `answerNode` → `respond`.

---

## Use Cases

| # | Role | Trigger | Agent detects / produces | Human decides | Path |
|---|------|---------|--------------------------|---------------|------|
| 1 | Engineer | Proactive (cron / mutation): `in_progress` with no activity ≥ 3 days | "Stalled: #142" finding + proposes moving it back to To Do | Approve the state change / snooze / dismiss | HITL |
| 2 | PM | Proactive: open work with no assignee | "Unassigned: #X" flag in the inbox + notify admins | Assign it (in Ship) — agent doesn't pick an owner | Autonomous |
| 3 | PM | Proactive: open work with no estimate | "No estimate: #X" flag, notify assignee | Add an estimate | Autonomous |
| 4 | Engineer / PM | Proactive: `due_date < today`, still open | "Overdue: #X (N days)" + proposes raising to Urgent | Approve priority bump / re-date / dismiss | HITL |
| 5 | Any | On-demand: chat from an issue / week / project | Grounded answer ("What's at risk?", "Who's overloaded?", "Is this week on track?") + suggested next action | Whether to act on the suggestion | On-demand read |
| 6 | Director / PM | Proactive (cron): active sprint where elapsed-fraction outpaces done-fraction (worse if confidence high) | "At risk of slipping: Week N — 71% elapsed, 20% done" finding to the sprint owner | Cut scope / reset confidence | Autonomous |
| 7 | Manager | Proactive (cron): `Σ estimate` of a person's open work > `capacity_hours` | "Overloaded: Dana (34h vs 20h)" + proposes reassigning the lowest-priority item to the teammate with the most slack; notifies `reports_to` | Approve the reassignment / dismiss | HITL |
| 8 | Any | On-demand: chat requests a change ("reassign #142 to Dana", "bump #88 to urgent") | Proposes a concrete action with validated ids; surfaces an inline Apply/Cancel | Apply or cancel | On-demand action (HITL) |
| 9 | Director / PM | Proactive (daily cron): per project | Daily digest — "what's moving, what's at risk, the single most important next action" | Read; act on the called-out next step | Autonomous (digest) |
| 10 | Team | Repeatedly dismissing a finding type | Agent learns to suppress that type after N dismissals (adaptive) | Nothing — the noise stops | (suppression at dedup) |
| 11 | Any | On-demand: chat asks about the workspace itself ("how many documents are there?", "list the wikis", "what projects exist?", "who's on the team?") | Grounded answer from the document census + index, across all document types (everything is a document) | — (informational) | On-demand read |

---

## Trigger Model — **Hybrid** (event-hook + cron sweep)

Defended choice: webhook-only misses "nothing happened" conditions; poll-only wastes runs and couples
latency to the interval. Hybrid gets sub-minute latency on *changes* and bounded latency on *absences*.

- **Real-time (mutation):** an in-process event fires from the issue **create and update** post-commit
  hooks (`api/src/routes/issues.ts` `POST`/`PATCH`), debounced ~15s (`FLEETGRAPH_DEBOUNCE_MS`) and run in the same process
  (no broker). Fetch (narrow, parallel) ≈ 0.5–2s · triage ≈ 1–3s · reason ≈ 3–8s · notify ≈ instant
  → **well under the 5-minute detection SLA** (typically < 1 min).
- **Scheduled (cron):** `node-cron` every 5 min (`FLEETGRAPH_CRON`) sweeps each workspace's open work
  to catch absence-class conditions (stale, overdue) that no mutation fires for. The interval *is* the
  latency for those classes → 5 min honors the SLA.
- **Horizontal-scale guard:** the sweep holds a `pg_try_advisory_lock`, so on a multi-instance EB
  fleet only one instance sweeps per tick.

---

## Timed Railway Latency Evidence

Timed against the live Railway deployment on **2026-05-28**:

```json
{
  "ok": true,
  "base": "https://shipshape-app-production-7ed8.up.railway.app",
  "deployment": "Railway production shipshape-app",
  "testDate": "2026-05-28T13:39:35.561Z",
  "trigger": "POST /api/issues mutation hook",
  "signal": "unassigned",
  "findingTitle": "Unassigned task: FleetGraph latency proof",
  "issueId": "ae3075e6-6f16-444c-a904-1007a3a7b89b",
  "elapsedMs": 21479,
  "elapsedSeconds": 21.5,
  "polls": 11
}
```

Test method: log in to the deployed app, create a uniquely named `todo` issue with no assignee, start
the timer at `POST /api/issues`, poll `GET /api/fleetgraph/inbox` every 2s, and stop when the finding
for that issue appears. The test issue was then patched to `state='done'` with `estimate=1`; follow-up
polling confirmed no open FleetGraph inbox item remained for that issue. Result: **21.5s mutation-path
detection latency**, well under the 5-minute SLA.

---

## Cost & Throughput Estimates

The dominant proactive path is still the **quiet path with zero LLM tokens**: `dedupFilter`
short-circuits before triage whenever a signal is already known and unchanged. These estimates use
[Anthropic public Claude pricing](https://docs.claude.com/en/docs/about-claude/pricing) for the
Railway path: Haiku at `$1/M` input + `$5/M` output tokens and Sonnet at `$3/M` input + `$15/M`
output tokens.

Assumptions for a planning estimate:

- 1 workspace; cron sweep every 5 minutes: `24 * 60 / 5 = 288` sweep runs/day.
- 12 issue create/update mutation runs per project/day.
- 5% of mutation runs survive dedup and call models; 95% end quiet before the LLM.
- 1 digest run per project/day.
- 2 on-demand chat runs per project/day.
- Token budget per model-bearing proactive signal: Haiku `2k in / 100 out` + Sonnet `4k in / 300 out`
  ≈ `$0.019/run`.
- Token budget per digest: Sonnet `6k in / 600 out` ≈ `$0.027/run`.
- Token budget per chat: Sonnet `5k in / 500 out` ≈ `$0.0225/run`.

Runs/day math:

```text
runs/day = cron_sweeps + mutation_runs + digest_runs + chat_runs
         = 288 + (12 * projects) + (1 * projects) + (2 * projects)
         = 288 + (15 * projects)

quiet_runs/day = cron_sweeps + dedup-quiet mutation runs
               = 288 + (12 * projects * 95%)

model_runs/day = token-bearing mutation runs + digest runs + chat runs
               = (12 * projects * 5%) + projects + (2 * projects)
               = 3.6 * projects
```

| Projects | Total runs/day | Quiet/no-model runs/day | Model runs/day | Avg run rate | Est. model cost/month |
|---:|---:|---:|---:|---:|---:|
| 10 | 438 | 402 | 36 | 0.005/sec | ~$25 |
| 100 | 1,788 | 1,428 | 360 | 0.021/sec | ~$250 |
| 1,000 | 15,288 | 11,688 | 3,600 | 0.177/sec | ~$2,502 |
| 10,000 | 150,288 | 114,288 | 36,000 | 1.739/sec | ~$25,020 |

Scaling interpretation: the run count is linear in project count, but the high-volume mutation path is
mostly cheap because dedup happens before any LLM call. The main cost knobs are digest frequency,
on-demand chat volume, and the percentage of mutation runs that survive dedup.

---

## State Management
- **Within a run:** `raw` caches all parallel fetches (no re-fetch); `signals`/`findings` accumulate.
- **Between proactive runs:** `fleetgraph_findings` (`UNIQUE(workspace_id, dedup_key)`) is the memory.
  `dedupFilter` drops a signal whose row exists and whose `content_hash` is unchanged; it re-surfaces
  only when the situation materially worsens (hash changes) or a snooze expires. Dismissed findings are
  permanently suppressed.
- **Paused runs:** the LangGraph checkpoint (thread = `runId`) holds full state in Postgres; the
  `fleetgraph_pending_approvals` row lets the inbox list pending approvals and lets an approval landing
  on any instance rehydrate the right thread.

---

## Running it

```bash
# DB (local Postgres) up, then:
pnpm dev                 # starts api + web; FleetGraph triggers start with the API

# Required env for live reasoning + tracing:
#   ANTHROPIC_API_KEY=sk-ant-...   # uses the Anthropic API; omit to fall back to AWS Bedrock (IAM role)
#   LANGCHAIN_TRACING_V2=true
#   LANGCHAIN_API_KEY=ls__...
#   LANGCHAIN_PROJECT=fleetgraph
# Optional tuning:
#   FLEETGRAPH_STALE_DAYS=3   FLEETGRAPH_DEBOUNCE_MS=15000   FLEETGRAPH_CRON="*/5 * * * *"
#   FLEETGRAPH_MODEL_TIER1 / FLEETGRAPH_MODEL_TIER2   FLEETGRAPH_DISABLED=1
```

In the UI: the **bell** (bottom-right) opens the inbox (findings + approval cards with
Approve / Snooze / Dismiss); the **chat** button opens context-aware chat scoped to the current view.

---

## Test Cases  *(Early Submission — trace links added once `LANGCHAIN_API_KEY` is set)*

Verified end-to-end against real seeded Ship data (`api` + Postgres), no mocks:

| # | Ship state | Expected output | Status |
|---|-----------|-----------------|--------|
| 1 | Open issue with no `assignee_id` | `unassigned` finding (auto), in inbox + notify | ✅ verified |
| 2 | Open issue with no `estimate` | `unestimated` finding (auto) | ✅ verified |
| 3 | Issue `due_date` in the past, not done | `overdue` finding + **pending approval** to raise Urgent | ✅ verified |
| 4 | Approve the overdue action | `priority` PATCHed `→ urgent`, `document_history` row `automated_by='fleetgraph'`, approval resolved | ✅ verified |
| 5 | Run the sweep again, nothing changed | **0 new findings** (dedup idempotent) | ✅ verified |
| 6 | On-demand chat with `scope` from current view | grounded answer (Tier-2) returned to the panel | ✅ verified (LLM path; falls back gracefully if Bedrock unavailable) |

### LangSmith trace links (different execution paths)

| Path | What it exercises | Trace |
|------|-------------------|-------|
| On-demand chat | `router → resolveContext → fetch ×4 → answerNode → respond` | https://smith.langchain.com/public/11e35f97-9a7d-4cf5-a666-813f24a3db8e/r |
| Proactive HITL | `detect → dedup → triage → reason → classify → surfaceAuto → humanGate (INTERRUPT)` | https://smith.langchain.com/public/7c242ba9-4411-42ce-8f90-398fa9065180/r |
| Proactive quiet | `detect → dedup → END` (dedup short-circuit, no LLM) | https://smith.langchain.com/public/fa64325b-b50b-4780-b1ac-68854141b832/r |

Three visibly different graph shapes from the same graph under different conditions — a graph, not a
pipeline. Captured with real Claude reasoning (Anthropic API, `claude-sonnet-4-6` / `claude-haiku-4-5`)
and `LANGCHAIN_TRACING_V2=true`.

---

## Architecture Decisions
- **LangGraph.js over Python** — keeps the agent in Ship's TS monorepo; still LangGraph, so LangSmith
  tracing is automatic and the "LangGraph recommended" constraint is met. Reuses Ship's API, types,
  auth, WebSocket, and toast.
- **Runtime provider switch (Bedrock / Anthropic)** — on EB the agent reuses Ship's in-prod Bedrock
  integration (IAM auth, no new secret); on Railway (no AWS creds) it uses the Anthropic API via
  `ANTHROPIC_API_KEY`. Same code, chosen by env (`llm.ts`). LangSmith captures token usage either way.
- **Postgres checkpointer over MemorySaver** — EB is multi-instance/ephemeral; in-memory state would
  lose interrupted HITL runs on deploy and break cross-instance resume.
- **Hybrid trigger over poll-only/webhook-only** — see Trigger Model.
- **In-process runner over a separate worker/broker** — one deploy, one secret store; debounced queue
  + advisory-locked cron are enough at this scale.
- **Deterministic detectors before any LLM** — the biggest cost lever; reasoning only runs on novel,
  triage-surviving signals.
- **CI/CD (CircleCI → Railway)** — every push runs type-check/build, the deterministic + LLM eval
  layers, and the graph/HITL integration tests. A green `main` auto-deploys the app (with the
  in-process agent) to Railway `dev`; promotion to `staging` and `production` is guarded by CircleCI
  human approval jobs. Secrets come from Railway/CircleCI environment variables.
