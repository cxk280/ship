#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const packages = [
  {
    name: 'api',
    summaryPath: 'api/coverage/coverage-summary.json',
    thresholds: {
      lines: 40,
      statements: 40,
      branches: 33,
      functions: 40,
    },
  },
  {
    name: 'web',
    summaryPath: 'web/coverage/coverage-summary.json',
    thresholds: {
      lines: 28,
      statements: 27,
      branches: 16,
      functions: 22,
    },
  },
];

let failed = false;

console.log('Package coverage ratchet thresholds:');
console.log('| Package | Metric | Actual | Minimum |');
console.log('| --- | --- | ---: | ---: |');

for (const pkg of packages) {
  const fullPath = path.join(repoRoot, pkg.summaryPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing coverage summary: ${pkg.summaryPath}`);
  }

  const total = JSON.parse(fs.readFileSync(fullPath, 'utf8')).total;
  for (const [metric, minimum] of Object.entries(pkg.thresholds)) {
    const actual = Number(total[metric]?.pct ?? 0);
    if (actual < minimum) {
      failed = true;
    }
    console.log(`| ${pkg.name} | ${metric} | ${actual.toFixed(2)}% | ${minimum.toFixed(2)}% |`);
  }
}

if (failed) {
  console.error('\nCoverage ratchet failed. Raise coverage or intentionally update the ratchet with evidence.');
  process.exitCode = 1;
}
