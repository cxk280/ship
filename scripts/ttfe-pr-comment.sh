#!/usr/bin/env bash
# scripts/ttfe-pr-comment.sh
#
# Post (or update) a single sticky PR comment with the latest Time-to-First-Event
# measurement: total ms, pass/fail vs the 60s budget, and the per-step breakdown.
# Reads the timing artifact written by the TTFE drill (test-results/ttfe.json).
#
# GRACEFUL DEGRADATION: if no GitHub token is available, or this isn't a PR
# build, or the artifact is missing, the script PRINTS what it would do and
# exits 0 — it must NEVER fail the build just because it can't comment.
#
# Env (all optional — provided by CircleCI on PR builds):
#   GITHUB_TOKEN / GH_TOKEN   — token with PR write access
#   CIRCLE_PULL_REQUEST       — PR URL (…/pull/<n>); absent on non-PR builds
#   CIRCLE_PROJECT_USERNAME   — repo owner  (fallback: cxk280)
#   CIRCLE_PROJECT_REPONAME   — repo name   (fallback: ship)

set -euo pipefail

ARTIFACT="${TTFE_ARTIFACT:-test-results/ttfe.json}"
MARKER="<!-- ttfe-trend -->"

# ── 1. Need a measurement to report ──────────────────────────────────────────
if [[ ! -f "$ARTIFACT" ]]; then
  echo "TTFE comment: no artifact at $ARTIFACT — nothing to report. Skipping (exit 0)."
  exit 0
fi

MS=$(node -e 'const a=require("./'"$ARTIFACT"'");process.stdout.write(String(a.ms))')
THRESHOLD=$(node -e 'const a=require("./'"$ARTIFACT"'");process.stdout.write(String(a.threshold_ms))')
PASSED=$(node -e 'const a=require("./'"$ARTIFACT"'");process.stdout.write(String(a.passed))')
STEPS=$(node -e 'const a=require("./'"$ARTIFACT"'");process.stdout.write(Object.entries(a.steps).map(([k,v])=>`| \`${k}\` | ${v} ms |`).join("\n"))')

SECONDS_FMT=$(node -e 'process.stdout.write(('"$MS"'/1000).toFixed(2))')
BUDGET_FMT=$(node -e 'process.stdout.write(('"$THRESHOLD"'/1000).toFixed(0))')
if [[ "$PASSED" == "true" ]]; then VERDICT="✅ PASS"; else VERDICT="❌ FAIL"; fi

BODY=$(cat <<EOF
$MARKER
### ⏱️ Time-to-First-Event (TTFE)

**${SECONDS_FMT}s** ($MS ms) — $VERDICT vs the ${BUDGET_FMT}s budget.

| step | duration |
|------|----------|
$STEPS

<sub>device login → subscribe → create document → receive signed webhook → verify. Updated automatically by CI.</sub>
EOF
)

# ── 2. Resolve token (optional) ──────────────────────────────────────────────
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [[ -z "$TOKEN" ]]; then
  echo "TTFE comment: no GITHUB_TOKEN/GH_TOKEN in env — printing comment instead of posting (exit 0)."
  echo "----------------------------------------"
  echo "$BODY"
  echo "----------------------------------------"
  exit 0
fi

# ── 3. Resolve the PR number (only comment on PR builds) ─────────────────────
if [[ -z "${CIRCLE_PULL_REQUEST:-}" ]]; then
  echo "TTFE comment: not a PR build (CIRCLE_PULL_REQUEST unset) — skipping (exit 0)."
  exit 0
fi
PR_NUMBER="${CIRCLE_PULL_REQUEST##*/}"
OWNER="${CIRCLE_PROJECT_USERNAME:-cxk280}"
REPO="${CIRCLE_PROJECT_REPONAME:-ship}"
API="https://api.github.com/repos/${OWNER}/${REPO}"

echo "TTFE comment: posting trend to ${OWNER}/${REPO}#${PR_NUMBER} …"

# ── 4. Find an existing sticky comment to update ─────────────────────────────
EXISTING_ID=$(curl -fsSL \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "${API}/issues/${PR_NUMBER}/comments?per_page=100" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const c=JSON.parse(s);const m=(Array.isArray(c)?c:[]).find(x=>typeof x.body==="string"&&x.body.includes("'"$MARKER"'"));process.stdout.write(m?String(m.id):"")}catch{process.stdout.write("")}})' || true)

# JSON-encode the body safely.
PAYLOAD=$(BODY="$BODY" node -e 'process.stdout.write(JSON.stringify({body:process.env.BODY}))')

if [[ -n "$EXISTING_ID" ]]; then
  curl -fsSL -X PATCH \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "${API}/issues/comments/${EXISTING_ID}" \
    -d "$PAYLOAD" >/dev/null \
    && echo "TTFE comment: updated existing comment ${EXISTING_ID}." \
    || { echo "TTFE comment: update failed — degrading gracefully (exit 0)."; exit 0; }
else
  curl -fsSL -X POST \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "${API}/issues/${PR_NUMBER}/comments" \
    -d "$PAYLOAD" >/dev/null \
    && echo "TTFE comment: created new comment." \
    || { echo "TTFE comment: create failed — degrading gracefully (exit 0)."; exit 0; }
fi

exit 0
