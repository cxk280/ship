#!/usr/bin/env node
// scripts/ttfe-badge.mjs
//
// Regenerate docs/ttfe-badge.json (shields.io endpoint-badge schema) from the
// TTFE drill's timing artifact (test-results/ttfe.json). The README badge points
// at this file's raw-GitHub URL, so refreshing it updates the badge.
//
// Usage:
//   node scripts/ttfe-badge.mjs                       # read test-results/ttfe.json
//   node scripts/ttfe-badge.mjs <artifact.json>       # explicit artifact path
//
// Color thresholds (vs the 60s budget): <30s green, <60s yellow, else red.
// If the artifact is missing, prints a notice and exits 0 (no-op) so a master
// build without a fresh measurement never breaks.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const artifactPath = process.argv[2] ?? 'test-results/ttfe.json';
const badgePath = 'docs/ttfe-badge.json';

let artifact;
try {
  artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
} catch {
  console.log(`ttfe-badge: no artifact at ${artifactPath} — leaving ${badgePath} unchanged (exit 0).`);
  process.exit(0);
}

const ms = Number(artifact.ms);
const thresholdMs = Number(artifact.threshold_ms ?? 60_000);
if (!Number.isFinite(ms)) {
  console.log(`ttfe-badge: artifact has no numeric "ms" — leaving ${badgePath} unchanged (exit 0).`);
  process.exit(0);
}

const seconds = ms / 1000;
const message = seconds < 10 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;

let color;
if (!artifact.passed || ms >= thresholdMs) color = 'red';
else if (ms < thresholdMs / 2) color = 'brightgreen';
else color = 'yellow';

const badge = { schemaVersion: 1, label: 'TTFE', message, color };

await mkdir(path.dirname(badgePath), { recursive: true });
await writeFile(badgePath, `${JSON.stringify(badge, null, 2)}\n`, 'utf8');
console.log(`ttfe-badge: wrote ${badgePath}: ${JSON.stringify(badge)}`);
