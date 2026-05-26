// FleetGraph Layer-1 eval runner: scores the deterministic detection + dedup/suppression layers
// against labeled cases (precision / recall / quiet-accuracy, plus severity & recipient checks and
// dedup-decision exactness). Pure, no DB, no LLM — repeatable in CI.
//   pnpm fleetgraph:eval
// If LANGCHAIN_API_KEY is set, also upserts the detector cases as a LangSmith dataset.
import { detectSignals, detectSprintSlip, detectCapacity } from '../detectors.js';
import { filterNovel } from '../dedup.js';
import { CASES, type EvalCase } from './cases.js';
import { DEDUP_CASES } from './dedup-cases.js';
import type { Signal } from '../types.js';

const OPTS = (c: EvalCase) => ({ now: c.now, fallbackRecipients: ['admin'] });

function producedSignals(c: EvalCase): Signal[] {
  return [
    ...detectSignals(c.issues, OPTS(c)),
    ...(c.team ? detectCapacity(c.team, c.issues, OPTS(c)) : []),
    ...(c.team && c.weeks && c.progress && c.meta
      ? detectSprintSlip(c.weeks, c.progress, c.team, c.meta, OPTS(c)) : []),
  ];
}

function runDetectorLayer() {
  let TP = 0, FP = 0, FN = 0, passCount = 0, quietTotal = 0, quietOk = 0;
  const rows: { name: string; ok: boolean; note: string }[] = [];

  for (const c of CASES) {
    const signals = producedSignals(c);
    const byType = new Map(signals.map((s) => [s.type, s]));
    const produced = new Set(byType.keys());
    const expected = new Set(c.expect);

    const tp = [...expected].filter((t) => produced.has(t)).length;
    const fp = [...produced].filter((t) => !expected.has(t)).length;
    const fn = [...expected].filter((t) => !produced.has(t)).length;
    TP += tp; FP += fp; FN += fn;

    let ok = fp === 0 && fn === 0;
    const notes: string[] = [];
    if (!ok) notes.push(`types expect[${[...expected]}] got[${[...produced]}]`);

    // severity checks
    for (const [type, sev] of Object.entries(c.expectSeverities ?? {})) {
      const got = byType.get(type)?.severity;
      if (got !== sev) { ok = false; notes.push(`severity ${type}: want ${sev} got ${got}`); }
    }
    // recipient checks
    if (c.expectRecipientsContain) {
      const recipients = new Set(signals.flatMap((s) => s.recipients));
      for (const r of c.expectRecipientsContain) {
        if (!recipients.has(r)) { ok = false; notes.push(`missing recipient ${r}`); }
      }
    }

    if (ok) passCount += 1;
    if (expected.size === 0) { quietTotal += 1; if (produced.size === 0) quietOk += 1; }
    rows.push({ name: c.name, ok, note: notes.join('; ') });
  }

  const precision = TP + FP === 0 ? 1 : TP / (TP + FP);
  const recall = TP + FN === 0 ? 1 : TP / (TP + FN);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { rows, passCount, total: CASES.length, precision, recall, f1, quietOk, quietTotal };
}

function runDedupLayer() {
  const rows: { name: string; ok: boolean; note: string }[] = [];
  let passCount = 0;
  for (const c of DEDUP_CASES) {
    const novel = filterNovel(c.signals, c.known, c.dismissals ?? {}, { now: c.now, suppressThreshold: 3 });
    const got = novel.map((s) => s.dedupKey).sort();
    const want = [...c.expectNovel].sort();
    const ok = got.length === want.length && got.every((k, i) => k === want[i]);
    if (ok) passCount += 1;
    rows.push({ name: c.name, ok, note: ok ? '' : `want[${want}] got[${got}]` });
  }
  return { rows, passCount, total: DEDUP_CASES.length };
}

async function main() {
  const det = runDetectorLayer();
  const dd = runDedupLayer();

  console.log('\nFleetGraph Layer-1 evals (deterministic)\n' + '='.repeat(78));
  console.log('Detectors:');
  for (const r of det.rows) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.note ? '  — ' + r.note : ''}`);
  console.log('Dedup / suppression:');
  for (const r of dd.rows) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.note ? '  — ' + r.note : ''}`);
  console.log('='.repeat(78));
  console.log(`detectors: ${det.passCount}/${det.total}  |  precision ${det.precision.toFixed(2)} recall ${det.recall.toFixed(2)} F1 ${det.f1.toFixed(2)}  |  quiet ${det.quietOk}/${det.quietTotal}`);
  console.log(`dedup:     ${dd.passCount}/${dd.total}`);

  if (process.env.LANGCHAIN_API_KEY) {
    try {
      const { Client } = await import('langsmith');
      const client = new Client();
      const name = 'fleetgraph-detector-evals';
      try {
        await client.readDataset({ datasetName: name });
      } catch {
        const dataset = await client.createDataset(name, { description: 'FleetGraph deterministic detector eval cases' });
        for (const c of CASES) await client.createExample({ case: c.name }, { expected: c.expect }, { datasetId: dataset.id });
      }
      console.log(`LangSmith dataset: ${name}`);
    } catch (e) {
      console.warn('LangSmith dataset upload skipped:', e instanceof Error ? e.message : e);
    }
  }

  const allPass = det.passCount === det.total && dd.passCount === dd.total;
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('eval run failed:', e); process.exit(1); });
