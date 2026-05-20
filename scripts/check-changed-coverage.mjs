#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const baseRef = process.env.CHANGED_COVERAGE_BASE || 'master';
const threshold = Number(process.env.CHANGED_COVERAGE_THRESHOLD || 80);
const coverageFiles = [
  path.join(repoRoot, 'api/coverage/coverage-final.json'),
  path.join(repoRoot, 'web/coverage/coverage-final.json'),
];

const sourceFilePattern = /^(api|web)\/src\/.*\.(ts|tsx)$/;
const excludedFilePattern = /(^|\/)(.*\.test\.(ts|tsx)|test\/|db\/schema\.sql$)/;
const e2eCoveredFiles = new Set([
  'web/src/components/StatusOverviewHeatmap.tsx',
  'web/src/pages/TeamMode.tsx',
]);
const unitCoverageExcludedFiles = new Set([
  'web/src/main.tsx',
  'web/src/pages/App.tsx',
  ...e2eCoveredFiles,
]);

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function getChangedLines() {
  const diff = git(['diff', '--unified=0', `${baseRef}...HEAD`, '--', 'api/src', 'web/src']);
  const changed = new Map();
  let currentFile = null;

  for (const line of diff.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      const file = fileMatch[1];
      currentFile = sourceFilePattern.test(file) && !excludedFilePattern.test(file) ? file : null;
      if (currentFile && !changed.has(currentFile)) {
        changed.set(currentFile, new Set());
      }
      continue;
    }

    if (!currentFile) continue;
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkMatch) continue;

    const start = Number(hunkMatch[1]);
    const count = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
    for (let offset = 0; offset < count; offset += 1) {
      changed.get(currentFile).add(start + offset);
    }
  }

  return changed;
}

function readCoverage() {
  const coverage = {};
  for (const file of coverageFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing coverage file: ${path.relative(repoRoot, file)}`);
    }
    Object.assign(coverage, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return coverage;
}

function normalizeCoveragePath(coveragePath) {
  return path.relative(repoRoot, path.resolve(coveragePath)).replaceAll(path.sep, '/');
}

function buildLineCoverage(fileCoverage) {
  const lineHits = new Map();
  for (const [statementId, location] of Object.entries(fileCoverage.statementMap || {})) {
    const count = Number(fileCoverage.s?.[statementId] || 0);
    for (let line = location.start.line; line <= location.end.line; line += 1) {
      const previous = lineHits.get(line) || 0;
      lineHits.set(line, Math.max(previous, count));
    }
  }
  return lineHits;
}

const changedLines = getChangedLines();
const coverage = readCoverage();
const coverageByPath = new Map(
  Object.entries(coverage).map(([file, data]) => [normalizeCoveragePath(file), data])
);

const results = [];
const skipped = [];
let totalCovered = 0;
let totalExecutable = 0;

for (const [file, lines] of changedLines.entries()) {
  if (unitCoverageExcludedFiles.has(file)) {
    skipped.push({
      file,
      reason: e2eCoveredFiles.has(file)
        ? 'covered by Playwright axe stretch test instead of unit coverage'
        : 'application shell/bootstrap file excluded from unit changed-line gate',
    });
    continue;
  }

  const fileCoverage = coverageByPath.get(file);
  if (!fileCoverage) {
    results.push({ file, executable: lines.size, covered: 0, pct: 0, missing: [...lines].sort((a, b) => a - b) });
    totalExecutable += lines.size;
    continue;
  }

  const lineCoverage = buildLineCoverage(fileCoverage);
  const executableLines = [...lines].filter(line => lineCoverage.has(line));
  const coveredLines = executableLines.filter(line => lineCoverage.get(line) > 0);

  if (executableLines.length === 0) {
    continue;
  }

  const pct = (coveredLines.length / executableLines.length) * 100;
  results.push({
    file,
    executable: executableLines.length,
    covered: coveredLines.length,
    pct,
    missing: executableLines.filter(line => !coveredLines.includes(line)),
  });
  totalExecutable += executableLines.length;
  totalCovered += coveredLines.length;
}

const overallPct = totalExecutable === 0 ? 100 : (totalCovered / totalExecutable) * 100;
const failing = overallPct < threshold || results.some(result => result.pct < threshold);

console.log(`Changed-line coverage threshold: ${threshold}%`);
console.log(`Base ref: ${baseRef}`);
console.log(`Overall: ${totalCovered}/${totalExecutable} lines (${overallPct.toFixed(2)}%)`);
console.log('');
console.log('| File | Covered changed lines | Coverage |');
console.log('| --- | ---: | ---: |');
for (const result of results.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log(`| ${result.file} | ${result.covered}/${result.executable} | ${result.pct.toFixed(2)}% |`);
  if (result.pct < threshold && result.missing.length > 0) {
    console.log(`| ${result.file} missing | ${result.missing.slice(0, 25).join(', ')}${result.missing.length > 25 ? ', ...' : ''} | |`);
  }
}
if (skipped.length > 0) {
  console.log('');
  console.log('Skipped from unit changed-line gate:');
  for (const item of skipped.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`- ${item.file}: ${item.reason}`);
  }
}

if (failing) {
  process.exitCode = 1;
}
