#!/usr/bin/env bash
#
# pr-protection.sh — configure master's branch protection around the
# OWNER-APPROVAL gate (see .github/workflows/owner-approval.yml).
#
# The gate model:
#   • The owner (cxk280) is ALWAYS the final approver. They approve a PR by adding
#     the "approved" label, which turns the required "owner-approval" status check
#     green. New commits reset it. This works on self-authored PRs (GitHub forbids
#     approving your own PR; a label/status is not a "review").
#   • The Codex review bot is ADVISORY ONLY. required_pull_request_reviews is null,
#     so neither the bot's APPROVE nor its REQUEST_CHANGES can gate or block merge.
#   • enforce_admins stays ON, so even the owner must apply their own label — you
#     cannot accidentally bypass your own gate.
#
# This is independent of whether the review bots are enabled, so you can disable
# them to save API spend without changing how merges are gated:
#   Disable bots: gh workflow disable "Codex PR Review" "Codex Cursor Handoff" "Create Codex Cursor PR Once"
#   Enable  bots: gh workflow enable  "Codex PR Review" "Codex Cursor Handoff" "Create Codex Cursor PR Once"
#
# Usage:
#   scripts/pr-protection.sh setup   # apply the owner-approval gate (idempotent)
#   scripts/pr-protection.sh status  # show current protection
#   scripts/pr-protection.sh bootstrap-off  # TEMPORARY: exempt admins for ONE merge
#                                            # (used once to install the workflow itself).
#   scripts/pr-protection.sh bootstrap-on   # restore admin enforcement.
#
set -euo pipefail

REPO="${PR_PROTECTION_REPO:-cxk280/ship}"
BRANCH="${PR_PROTECTION_BRANCH:-master}"
API="repos/${REPO}/branches/${BRANCH}/protection"
APPROVE_LABEL="approved"

ensure_label() {
  gh label create "${APPROVE_LABEL}" \
    --repo "${REPO}" \
    --color "0E8A16" \
    --description "Owner approval — turns the owner-approval check green and unblocks merge" \
    --force >/dev/null 2>&1 || true
}

case "${1:-status}" in
  setup)
    ensure_label
    echo "→ Applying owner-approval gate to ${BRANCH}…"
    gh api -X PUT "${API}" --input - >/dev/null <<JSON
{
  "required_status_checks": { "strict": true, "contexts": ["owner-approval"] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": false,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON
    echo "✓ master: required check 'owner-approval' · reviews advisory (null) · enforce-admins on."
    echo "  Approve a PR by adding the '${APPROVE_LABEL}' label; new commits reset it."
    ;;
  bootstrap-off)
    echo "→ BOOTSTRAP: exempting admins on ${BRANCH} for ONE merge (review requirement stays)."
    gh api -X DELETE "${API}/enforce_admins" >/dev/null
    echo "✓ enforce_admins OFF. Admin-merge the install PR, then run: $0 setup"
    ;;
  bootstrap-on)
    gh api -X POST "${API}/enforce_admins" >/dev/null
    echo "✓ enforce_admins ON."
    ;;
  status)
    gh api "${API}" --jq '{
      required_status_checks: (.required_status_checks.contexts // []),
      strict: .required_status_checks.strict,
      enforce_admins: .enforce_admins.enabled,
      required_reviews: (.required_pull_request_reviews.required_approving_review_count // "none (advisory)"),
      required_conversation_resolution: .required_conversation_resolution.enabled
    }'
    ;;
  *)
    echo "usage: $0 {setup|status|bootstrap-off|bootstrap-on}" >&2
    exit 2
    ;;
esac
