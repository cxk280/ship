// FleetGraph detector eval runner: scores the deterministic detection layer against labeled
// cases (precision / recall / quiet-accuracy). Deterministic + no DB, so it's repeatable in CI.
//   pnpm fleetgraph:eval
// If LANGCHAIN_API_KEY is set, also upserts the cases as a LangSmith dataset for visibility.
import { detectSignals, detectSprintSlip, detectCapacity } from '../detectors.js';
import { CASES, type EvalCase } from './cases.js';

const OPTS = (c: EvalCase) => ({ now: c.now, fallbackRecipients: ['admin'] });

function producedTypes(c: EvalCase): Set<string> {
  const sigs = [
    ...detectSignals(c.issues, OPTS(c)),
    ...(c.team ? detectCapacity(c.team, c.issues, OPTS(c)) : []),
    ...(c.team && c.weeks && c.progress && c.meta
      ? detectSprintSlip(c.weeks, c.progress, c.team, c.meta, OPTS(c)) : []),
  ];
  return new Set(sigs.map((s) => s.type));
}

async function main() {
  let TP = 0, FP = 0, FN = 0, passCount = 0, quietTotal = 0, quietOk = 0;
  const rows: { name: string; expected: string; produced: string; pass: boolean }[] = [];

  for (const c of CASES) {
    const produced = producedTypes(c);
    const expected = new Set(c.expect);
    const tp = [...expected].filter((t) => produced.has(t)).length;
    const fp = [...produced].filter((t) => !expected.has(t)).length;
    const fn = [...expected].filter((t) => !produced.has(t)).length;
    TP += tp; FP += fp; FN += fn;
    const pass = fp === 0 && fn === 0;
    if (pass) passCount += 1;
    if (expected.size === 0) { quietTotal += 1; if (produced.size === 0) quietOk += 1; }
    rows.push({
      name: c.name,
      expected: [...expected].join(', ') || '(quiet)',
      produced: [...produced].join(', ') || '(none)',
      pass,
    });
  }

  const precision = TP + FP === 0 ? 1 : TP / (TP + FP);
  const recall = TP + FN === 0 ? 1 : TP / (TP + FN);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const quietAcc = quietTotal === 0 ? 1 : quietOk / quietTotal;

  console.log('\nFleetGraph detector evals\n' + '='.repeat(72));
  for (const r of rows) {
    console.log(`${r.pass ? '✅' : '❌'} ${r.name.padEnd(28)} expect[${r.expected}]  got[${r.produced}]`);
  }
  console.log('='.repeat(72));
  console.log(`cases: ${passCount}/${CASES.length} exact  |  precision ${precision.toFixed(2)}  recall ${recall.toFixed(2)}  F1 ${f1.toFixed(2)}  |  quiet-accuracy ${quietOk}/${quietTotal} (${quietAcc.toFixed(2)})`);

  if (process.env.LANGCHAIN_API_KEY) {
    try {
      const { Client } = await import('langsmith');
      const client = new Client();
      const name = 'fleetgraph-detector-evals';
      let dataset;
      try {
        dataset = await client.readDataset({ datasetName: name });
      } catch {
        dataset = await client.createDataset(name, { description: 'FleetGraph deterministic detector eval cases' });
        for (const c of CASES) {
          await client.createExample({ case: c.name }, { expected: c.expect }, { datasetId: dataset.id });
        }
      }
      console.log(`LangSmith dataset: ${name} (${dataset.id})`);
    } catch (e) {
      console.warn('LangSmith dataset upload skipped:', e instanceof Error ? e.message : e);
    }
  }

  process.exit(passCount === CASES.length ? 0 : 1);
}

main().catch((e) => { console.error('eval run failed:', e); process.exit(1); });
