/**
 * Validation tools CLI (synthetic fixtures verify the tools; real evidence must come from real annotated data).
 *   npm run validate -- ocr    --annotations A.json --results R.json [--out report.json]
 *   npm run validate -- pose   --reference REF.json --results R.json [--tolerances '{"metric":2}'] [--out report.json]
 *   npm run validate -- device --log LOG.json [--out report.json]
 *   npm run validate -- rule   --dossier D.json [--evaluator ./module.js] [--out report.json]
 * Exit codes: 0 = report written · 2 = bad input · 3 (rule only) = dossier incomplete or a boundary case failed.
 * The reports state whether the data could support an accuracy statement at all; they never declare anything validated.
 */
import * as fs from 'fs';
import * as path from 'path';
import { evaluateOcr } from '../src/validation/ocr-eval';
import { evaluatePose } from '../src/validation/pose-eval';
import { evaluateDevice } from '../src/validation/device-eval';
import { checkRuleDossier, RuleEvaluator } from '../src/validation/rule-approval';
import { ValidationInputError } from '../src/validation/common';

const argv = process.argv.slice(2); const cmd = argv.shift();
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const need = (n: string) => { const v = opt(n); if (!v) { console.error(`missing --${n}`); process.exit(2); } return v as string; };
const load = (p: string) => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));

try {
  let report: unknown; let code = 0;
  if (cmd === 'ocr') report = evaluateOcr(load(need('annotations')), load(need('results')));
  else if (cmd === 'pose') report = evaluatePose(load(need('reference')), load(need('results')), { tolerances: opt('tolerances') ? JSON.parse(opt('tolerances')!) : undefined });
  else if (cmd === 'device') report = evaluateDevice(load(need('log')));
  else if (cmd === 'rule') {
    let ev: RuleEvaluator | undefined;
    if (opt('evaluator')) { const m = require(path.resolve(opt('evaluator')!)); ev = m.evaluate ?? m.default; if (typeof ev !== 'function') { console.error('evaluator module must export evaluate(input) → string'); process.exit(2); } }
    const r = checkRuleDossier(load(need('dossier')), ev); report = r; if (r.status === 'incomplete') code = 3;
  } else { console.error('usage: validate <ocr|pose|device|rule> …  (see header of scripts/validate.ts)'); process.exit(2); }
  const text = JSON.stringify(report, null, 2) + '\n';
  if (opt('out')) fs.writeFileSync(path.resolve(opt('out')!), text); else process.stdout.write(text);
  const ev = (report as any).evidence;
  if (ev) console.error(`dataset structure: ${ev.datasetAdequacy.structuralMinimumsMet ? 'meets the stated minimums' : `below minimums — ${ev.datasetAdequacy.reasons.join('; ')}`}. ${ev.disclaimer}`);
  if (cmd === 'rule') console.error(`dossier status: ${(report as any).status}`);
  process.exit(code);
} catch (e) {
  if (e instanceof ValidationInputError) { console.error(`input problems:\n - ${e.problems.join('\n - ')}`); process.exit(2); }
  throw e;
}
