#!/usr/bin/env node
/**
 * @ship/sdk install-size gate (PRD target: < 250 KB, production deps only,
 * minified + gzipped).
 *
 * The SDK is built with zero runtime dependencies (native fetch + node:crypto),
 * so the install footprint is just its own compiled output. We enforce both
 * invariants: (1) zero runtime deps — otherwise dist alone can't represent the
 * install size; (2) the gzipped built output stays under budget.
 *
 * Run after `pnpm build:sdk`.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SDK = path.resolve('sdk');
const LIMIT_BYTES = 250 * 1024;

const pkg = JSON.parse(readFileSync(path.join(SDK, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {});
if (deps.length > 0) {
  console.error(
    `❌ @ship/sdk must keep ZERO runtime dependencies (found: ${deps.join(', ')}).\n` +
      `   Install size can no longer be measured from dist alone — revisit this gate.`,
  );
  process.exit(1);
}

function jsFiles(dir) {
  let out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(jsFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const dist = path.join(SDK, 'dist');
let files = [];
try {
  files = jsFiles(dist);
} catch {
  console.error('❌ sdk/dist not found — run `pnpm build:sdk` first.');
  process.exit(1);
}
if (files.length === 0) {
  console.error('❌ sdk/dist has no .js output — run `pnpm build:sdk` first.');
  process.exit(1);
}

const concat = Buffer.concat(files.map((f) => readFileSync(f)));
const gz = gzipSync(concat, { level: 9 }).length;
const kb = (gz / 1024).toFixed(1);
console.log(`@ship/sdk: ${kb} KB gzipped (${files.length} files, 0 runtime deps); budget ${LIMIT_BYTES / 1024} KB`);

if (gz > LIMIT_BYTES) {
  console.error(`❌ SDK bundle ${kb} KB exceeds the ${LIMIT_BYTES / 1024} KB budget.`);
  process.exit(1);
}
console.log('✓ SDK within install-size budget.');
