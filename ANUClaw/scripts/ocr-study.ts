/**
 * OCR validation-study workflow CLI (SYNTHETIC-ONLY until a real protocol is approved and every approval in the preregistration is signed by a person).
 *
 *   --root DIR is REQUIRED (no default: study data must never land in the repository by accident). --scope tenant:ID|user:ID and --user ID are ASSERTED
 *   identities for this local tool (no authentication here). See src/validation/study/workspace.ts.
 *
 *   ocr-study workspace   --root R --scope S --user U --name N --purpose P
 *   ocr-study add-member  … --ws W --member M --roles owner,annotator,adjudicator,analyst
 *   ocr-study register    … --ws W --sources-file sources.json --name N --study-ref REF --kind synthetic_fixture|human_annotated --split development|locked_validation|external_validation
 *                           --origin TEXT --annotators A,B [--protocol-ref REF]      (sources.json: [{"file","pages","mediaType"}] relative to the file)
 *   ocr-study attest      … --ws W --dataset D --record attestation.json             (a human-supplied record; recorded, not verified)
 *   ocr-study manifest    … --ws W --dataset D
 *   ocr-study import      … --ws W --dataset D --file annotations.json [--fixture-keys]   (--fixture-keys maps "@1","@2"… to case ids; synthetic datasets only)
 *   ocr-study review      … --ws W --dataset D                                       (agreement + disagreement queue)
 *   ocr-study adjudicate  … --ws W --dataset D --queue-id Q --source a|b|other|ambiguous --reason TEXT [--final-value JSON]
 *   ocr-study truth       … --ws W --dataset D
 *   ocr-study lock        … --ws W --dataset D                  → prints the lock digest: record it OUTSIDE the study directory
 *   ocr-study unlock      … --ws W --dataset D --authorization unlock-authorization.json   (a record written by a human; no bypass exists)
 *   ocr-study verify      … --ws W --dataset D [--expect-lock-digest HEX]
 *   ocr-study evaluate    … --ws W --dataset D --run-id R --mode development|locked --results results.json   (thresholds/minimums/tolerance/labels come from the OCR study POLICY, not options; locked runs need results stamped with `ocr-study policy-stamp`)
 *   ocr-study export      … --ws W --dataset D --run-id R --out report.json
 *   ocr-study audit       … --ws W
 * Nothing here decides acceptance. Exit codes: 0 ok · 2 bad input/refused.
 */
import * as fs from 'fs';
import * as path from 'path';
import { StudyWorkspaces, Actor } from '../src/validation/study/workspace';
import { ProvenanceKind, Split, StudyError } from '../src/validation/study/manifest';
import { stampOf, SYNTHETIC_VIEW, PolicyError } from '../src/ocr-policy/policy';
import { Role } from '../src/validation/study/workspace';

interface Json { [k: string]: unknown }

const argv = process.argv.slice(2); const cmd = argv.shift();
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (n: string) => argv.includes(`--${n}`);
const need = (n: string) => { const v = opt(n); if (!v) { console.error(`missing --${n}`); process.exit(2); } return v as string; };
const json = (p: string) => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));

try {
  const svc = new StudyWorkspaces(path.resolve(need('root')));
  const [kind, sid] = need('scope').split(':'); if (!['tenant', 'user'].includes(kind) || !sid) { console.error('--scope must be tenant:ID or user:ID'); process.exit(2); }
  const actor: Actor = { userId: need('user'), scope: { kind: kind as 'tenant' | 'user', id: sid } };
  const ws = () => need('ws'); const ds = () => need('dataset'); const out = (x: unknown) => console.log(JSON.stringify(x, null, 1));
  switch (cmd) {
    case 'workspace': out(svc.createWorkspace(actor, need('name'), need('purpose'))); break;
    case 'add-member': svc.addMember(actor, ws(), need('member'), need('roles').split(',') as Role[]); console.log('ok'); break;
    case 'register': {
      const sf = path.resolve(need('sources-file')); const list = json(sf) as Array<{ file: string; pages: number; mediaType: string }>;
      const a = need('annotators').split(',') as [string, string];
      out(svc.registerDataset(actor, ws(), { name: need('name'), studyRef: need('study-ref'), provenanceKind: need('kind') as ProvenanceKind, split: need('split') as Split, protocolRef: opt('protocol-ref'), origin: need('origin'), annotators: a,
        sources: list.map((s) => ({ bytes: fs.readFileSync(path.resolve(path.dirname(sf), s.file)), pages: s.pages, mediaType: s.mediaType })) })); break;
    }
    case 'attest': out(svc.attestDeidentification(actor, ws(), ds(), json(need('record')))); break;
    case 'manifest': out(svc.generateManifest(actor, ws(), ds())); break;
    case 'import': {
      let f = json(need('file')) as Json;
      if (flag('fixture-keys')) {
        const m = svc.getManifest(actor, ws(), ds()); if (m.provenanceKind !== 'synthetic_fixture') throw new StudyError('forbidden', '--fixture-keys is for synthetic datasets only.', 403);
        const map = (k: string) => (/^@(\d+)$/.test(k) ? m.cases[Number(k.slice(1)) - 1]?.caseId ?? k : k);
        f = { ...f, completedCaseIds: (f.completedCaseIds as string[]).map(map), items: (f.items as Array<Json & { caseId: string }>).map((i) => ({ ...i, caseId: map(i.caseId) })) };
      }
      out(svc.importAnnotations(actor, ws(), ds(), f)); break;
    }
    case 'review': out(svc.agreementReport(actor, ws(), ds())); break;
    case 'adjudicate': out(svc.adjudicate(actor, ws(), ds(), { queueId: need('queue-id'), source: need('source') as 'a' | 'b' | 'other' | 'ambiguous', reason: need('reason'), finalValue: opt('final-value') ? JSON.parse(opt('final-value')!) : undefined })); break;
    case 'truth': out(svc.buildTruth(actor, ws(), ds())); break;
    case 'lock': out(svc.lock(actor, ws(), ds())); break;
    case 'unlock': { const m = svc.unlock(actor, ws(), ds(), json(need('authorization'))); console.log(`UNLOCKED (epoch ${m.lock.epoch}). The dataset is permanently marked as having been unlocked.`); break; }
    case 'verify': { const r = svc.verify(actor, ws(), ds(), opt('expect-lock-digest')); out(r); if (!r.ok) process.exit(2); break; }
    case 'evaluate': {
      if (opt('options')) { console.error('--options is no longer supported: values come from the OCR study policy'); process.exit(2); }
      const r = svc.evaluate(actor, ws(), ds(), { runId: need('run-id'), mode: need('mode') as 'development' | 'locked', results: json(need('results')) }); console.log(`report ${r.file}\nsha256 ${r.reportSha256}\nnote: no acceptance decision is made by this tool.`); break;
    }
    case 'export': { const r = svc.exportReport(actor, ws(), ds(), need('run-id')); fs.writeFileSync(path.resolve(need('out')), r.text); console.log(`exported; sha256 ${r.sha256}`); break; }
    case 'policy-stamp': out(stampOf(SYNTHETIC_VIEW)); break;                      // the labelled SYNTHETIC test policy version the CLI evaluates under
    case 'audit': out({ verify: svc.verifyAuditLog(actor, ws()), entries: svc.auditEntries(actor, ws()) }); break;
    default: console.error('usage: ocr-study <workspace|add-member|register|attest|manifest|import|review|adjudicate|truth|lock|unlock|verify|evaluate|export|audit> … (see the header of scripts/ocr-study.ts)'); process.exit(2);
  }
} catch (e) {
  if (e instanceof StudyError) { console.error(`${e.code}: ${e.message}`); process.exit(2); }
  if (e instanceof PolicyError) { console.error(`${e.code}: ${e.message}`); process.exit(2); }
  throw e;
}
