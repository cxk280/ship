#!/usr/bin/env node
/**
 * Public / internal API boundary checker — the "one-way door" lint rule.
 *
 * The PRD makes this non-optional: "Lint rule fails the build if a public route
 * imports from internal handler files" and "External integrations live in
 * integrations/ and import only @ship/sdk — never api/src/."
 *
 * We enforce both as import-graph rules. We add the rule BEFORE the first
 * cross-import can exist, because retrofitting the boundary after a leak is far
 * more expensive than enforcing it on day one.
 *
 * Usage:  node scripts/check-api-boundary.mjs   (exits non-zero on violation)
 * Also imported by api/src/platform/__tests__/boundary.test.ts so it fails CI.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Each rule: files under `dir` may only use RELATIVE imports that resolve to a
 * path within `allowWithin`. Non-relative imports (npm packages, @ship/sdk,
 * @ship/shared) are always allowed.
 */
const RULES = [
  {
    name: 'public-edge isolation',
    dir: 'api/src/platform/api/v1',
    allowWithin: 'api/src/platform',
    why: 'files under api/src/platform/api/v1 may only import within api/src/platform — inject internal collaborators via the composition root, never import them directly',
  },
  {
    name: 'integrations use only the SDK',
    dir: 'integrations',
    allowWithin: 'integrations',
    why: 'integrations/ may import only @ship/sdk (and npm deps) — never api/src',
  },
];

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const IGNORE_DIRS = new Set(['node_modules', 'dist', '__tests__', '.git']);

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory doesn't exist yet (e.g. integrations/) — rule is a no-op
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out = out.concat(walk(full));
    } else if (SOURCE_EXT.has(full.slice(full.lastIndexOf('.')))) {
      out.push(full);
    }
  }
  return out;
}

// Match `... from '<spec>'` and side-effect `import '<spec>'` and `import('<spec>')`.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function isWithin(childAbs, parentAbs) {
  const rel = relative(parentAbs, childAbs);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^\.\.[\\/]/.test(rel));
}

export function findBoundaryViolations() {
  const violations = [];
  for (const rule of RULES) {
    const dirAbs = join(REPO_ROOT, rule.dir);
    const allowAbs = join(REPO_ROOT, rule.allowWithin);
    for (const file of walk(dirAbs)) {
      const src = readFileSync(file, 'utf8');
      let m;
      IMPORT_RE.lastIndex = 0;
      while ((m = IMPORT_RE.exec(src)) !== null) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue; // npm / workspace packages are fine
        const resolved = resolve(dirname(file), spec);
        if (!isWithin(resolved, allowAbs)) {
          violations.push({
            rule: rule.name,
            why: rule.why,
            file: relative(REPO_ROOT, file),
            import: spec,
            resolvesTo: relative(REPO_ROOT, resolved),
          });
        }
      }
    }
  }
  return violations;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = findBoundaryViolations();
  if (violations.length === 0) {
    console.log('✅ API boundary clean — no public→internal cross-imports.');
    process.exit(0);
  }
  console.error(`\n❌ API boundary violations (${violations.length}):\n`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.file}`);
    console.error(`      imports "${v.import}"  →  ${v.resolvesTo}`);
    console.error(`      ${v.why}\n`);
  }
  process.exit(1);
}
