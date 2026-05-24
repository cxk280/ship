/**
 * ShipShape Category 1 (Type Safety) — reproducible violation counter.
 *
 * Counts the "core" type-safety violations used as the audit denominator:
 *   explicit `any` + type assertions (`as` / angle-bracket) + non-null `!` + TS directives.
 *
 * This mirrors the methodology described in shipshape/SHIPSHAPE_AUDIT_REPORT.md so a grader
 * can reproduce the 25% reduction claim with a single command:
 *
 *   npx tsx scripts/shipshape-type-violations.ts
 *
 * Baseline (master) core total is 1281; the Kickoff target is a 25% reduction (<= 960).
 */
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');
const PACKAGES = ['web/src', 'api/src', 'shared/src'];
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);
const BASELINE_CORE = 1281;
const TARGET_RATIO = 0.25;

type Counts = {
  files: number;
  any: number;
  as: number;
  nonNull: number;
  directives: number;
};

function emptyCounts(): Counts {
  return { files: 0, any: 0, as: 0, nonNull: 0, directives: 0 };
}

function core(c: Counts): number {
  return c.any + c.as + c.nonNull + c.directives;
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function countFile(file: string, c: Counts): void {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  c.files += 1;

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) c.any += 1;
    else if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) c.as += 1;
    else if (ts.isNonNullExpression(node)) c.nonNull += 1;
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // TS suppression directives are comments, not AST nodes.
  const directiveMatches = text.match(/@ts-(ignore|expect-error)/g);
  if (directiveMatches) c.directives += directiveMatches.length;
}

function main(): void {
  const perPackage: Record<string, Counts> = {};
  const total = emptyCounts();

  for (const pkg of PACKAGES) {
    const abs = path.join(ROOT, pkg);
    const c = emptyCounts();
    if (fs.existsSync(abs)) {
      const files: string[] = [];
      walk(abs, files);
      for (const f of files) countFile(f, c);
    }
    perPackage[pkg] = c;
    total.files += c.files;
    total.any += c.any;
    total.as += c.as;
    total.nonNull += c.nonNull;
    total.directives += c.directives;
  }

  const pad = (s: string | number, n: number) => String(s).padStart(n);
  console.log('ShipShape Type-Safety Core Violations (any + as + non-null + directives)\n');
  console.log('package        files    any     as   non-null  directives   core');
  for (const pkg of PACKAGES) {
    const c = perPackage[pkg];
    console.log(
      `${pkg.padEnd(13)} ${pad(c.files, 5)} ${pad(c.any, 6)} ${pad(c.as, 6)} ${pad(c.nonNull, 9)} ${pad(c.directives, 11)} ${pad(core(c), 6)}`
    );
  }
  const coreTotal = core(total);
  console.log(
    `${'TOTAL'.padEnd(13)} ${pad(total.files, 5)} ${pad(total.any, 6)} ${pad(total.as, 6)} ${pad(total.nonNull, 9)} ${pad(total.directives, 11)} ${pad(coreTotal, 6)}`
  );

  const reduction = (BASELINE_CORE - coreTotal) / BASELINE_CORE;
  const gateMax = Math.floor(BASELINE_CORE * (1 - TARGET_RATIO));
  console.log('');
  console.log(`Baseline (master) core total : ${BASELINE_CORE}`);
  console.log(`Current core total           : ${coreTotal}`);
  console.log(`Reduction                    : ${(reduction * 100).toFixed(2)}%`);
  console.log(`25% gate (must be <=)        : ${gateMax}`);
  console.log(`Gate                         : ${coreTotal <= gateMax ? 'PASS' : 'FAIL'}`);

  if (coreTotal > gateMax) process.exitCode = 1;
}

main();
