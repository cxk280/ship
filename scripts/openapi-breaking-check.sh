#!/usr/bin/env bash
# scripts/openapi-breaking-check.sh
#
# Gate: regenerate the public /api/v1 OpenAPI spec and diff it against the base
# branch using oasdiff.  Exits non-zero if ANY breaking change is detected.
#
# Usage (local or CI):
#   BASE_BRANCH=master ./scripts/openapi-breaking-check.sh
#
# Required env:
#   BASE_BRANCH   — git ref to compare against (default: master)
#
# The script installs oasdiff automatically when it is absent, so the only
# runtime dependencies are bash, curl, tar, and a working Node/pnpm env.

set -euo pipefail

BASE_BRANCH="${BASE_BRANCH:-master}"
CURRENT_SPEC="docs/openapi.json"
BASE_SPEC="/tmp/openapi-base.json"

# ── 1. Ensure oasdiff is available ───────────────────────────────────────────
install_oasdiff() {
  local os arch version tarball_url bin_dir asset_os asset_arch

  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  # oasdiff release asset naming:
  #   Linux:  oasdiff_VERSION_linux_amd64.tar.gz  (or arm64)
  #   macOS:  oasdiff_VERSION_darwin_all.tar.gz   (universal binary)
  case "$os" in
    linux)
      asset_os="linux"
      case "$arch" in
        x86_64)           asset_arch="amd64" ;;
        aarch64|arm64)    asset_arch="arm64" ;;
        *)                echo "Unsupported arch: $arch"; exit 1 ;;
      esac
      ;;
    darwin)
      asset_os="darwin"
      asset_arch="all"   # universal binary — no arch suffix needed
      ;;
    *)
      echo "Unsupported OS: $os"; exit 1 ;;
  esac

  version=$(curl -fsSL "https://api.github.com/repos/oasdiff/oasdiff/releases/latest" \
    | grep '"tag_name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')

  tarball_url="https://github.com/oasdiff/oasdiff/releases/download/v${version}/oasdiff_${version}_${asset_os}_${asset_arch}.tar.gz"

  echo "Installing oasdiff v${version} (${asset_os}/${asset_arch}) …"

  # Install to a directory writable without sudo in both local and CI envs.
  # ~/bin works in CircleCI cimg/node; fall back to /tmp/oasdiff-bin.
  if mkdir -p "$HOME/bin" 2>/dev/null && [[ -w "$HOME/bin" ]]; then
    bin_dir="$HOME/bin"
  else
    bin_dir="/tmp/oasdiff-bin"
    mkdir -p "$bin_dir"
  fi

  curl -fsSL "$tarball_url" | tar -xz -C "$bin_dir" oasdiff
  export PATH="$bin_dir:$PATH"
  echo "oasdiff installed to $bin_dir/oasdiff"
}

if ! command -v oasdiff &>/dev/null; then
  install_oasdiff
fi

echo "oasdiff $(oasdiff version 2>/dev/null || true)"

# ── 2. Regenerate the current spec ───────────────────────────────────────────
echo ""
echo "==> Regenerating OpenAPI spec …"
# write-static.ts writes to docs/openapi.json relative to the repo root
pnpm --filter @ship/api openapi:v1

# ── 3. Fetch the base spec ───────────────────────────────────────────────────
echo ""
echo "==> Fetching base spec from ${BASE_BRANCH}:${CURRENT_SPEC} …"
if git show "origin/${BASE_BRANCH}:${CURRENT_SPEC}" > "$BASE_SPEC" 2>/dev/null; then
  echo "Base spec fetched from origin/${BASE_BRANCH}."
elif git show "${BASE_BRANCH}:${CURRENT_SPEC}" > "$BASE_SPEC" 2>/dev/null; then
  echo "Base spec fetched from local ${BASE_BRANCH}."
else
  echo "WARNING: No baseline spec found on ${BASE_BRANCH}. Treating as first-ever spec — skipping breaking-change check."
  echo "RESULT: PASS (no baseline)"
  exit 0
fi

# ── 4. Run the breaking-change diff ──────────────────────────────────────────
echo ""
echo "==> Diffing base vs current …"
set +e
BREAKING_OUTPUT=$(oasdiff breaking "$BASE_SPEC" "$CURRENT_SPEC" 2>&1)
OASDIFF_EXIT=$?
set -e

echo "$BREAKING_OUTPUT"

if [[ $OASDIFF_EXIT -ne 0 ]]; then
  echo ""
  echo "ERROR: oasdiff exited with code $OASDIFF_EXIT (tool error, not a spec diff)."
  exit "$OASDIFF_EXIT"
fi

# oasdiff breaking always exits 0 (even when breaking changes exist).
# A clean run prints "No changes detected".
# A run with breaking changes prints a summary line plus per-change detail
# lines, each starting with "error<TAB>[...]".  We count those lines.
ERROR_LINES=$(echo "$BREAKING_OUTPUT" | grep -cE '^error[[:space:]]' || true)
ERROR_LINES="${ERROR_LINES:-0}"

if [[ "$ERROR_LINES" -gt 0 ]]; then
  echo ""
  echo "FAIL: ${ERROR_LINES} breaking change(s) detected in /api/v1 OpenAPI spec."
  echo "Per the Plugforge versioning policy, /v1 must be additive-only."
  echo "To introduce breaking changes, create a /v2 endpoint."
  exit 1
fi

echo ""
echo "PASS: No breaking changes detected in /api/v1 OpenAPI spec."
exit 0
