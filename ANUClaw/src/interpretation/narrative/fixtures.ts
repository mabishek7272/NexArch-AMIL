/** Shared synthetic fixtures for the narrative tests: real adapter output run through real governance. */
import * as fs from 'fs';
import * as path from 'path';
import { contentHash } from '../../cds/hashing';
import { bundlePayloadOf, syntheticPosture } from '../../integrations/posturepulse/fixtures';
import { signBundle } from '../../integrations/posturepulse/upstream';
import { BEAIVE_GOVERNANCE, beaiveAdapter } from '../adapters/beaive';
import { posturepulseAdapter, POSTUREPULSE_FORMAT } from '../adapters/posturepulse';
import type { AdapterOutput, StoredRequest } from '../adapters/types';
import { EMPTY_CONTEXT, FindingsDoc, GovernanceContext, governFindings } from '../governance';

export const NOW = Date.parse('2026-08-21T09:00:00Z');
const example = JSON.parse(fs.readFileSync(path.join(__dirname, '../contracts/examples/beaive-vitals.request.json'), 'utf8'));

export function docFrom(out: AdapterOutput, adapterId: string, over: Partial<FindingsDoc> = {}): FindingsDoc {
  return {
    schemaVersion: 'normalized-findings/v1', jobId: 'job_000000000000000000000001', tenantId: 'tenant-synth', skillId: 'skill', subjectRef: 'SUBJ-LEAK-CHECK-001',
    capturedAt: '2026-08-20T08:31:00Z', findings: out.findings, flags: out.flags,
    provenance: { adapter: { id: adapterId, version: '1.0.0' }, sourceModel: { application: 'beAIve', modelName: 'm', modelVersion: '1', researchStatus: 'under_research' }, ruleset: { id: 'intake-normalisation', version: '1.0.0' }, originalPayloadSha256: 'a'.repeat(64) },
    findingsSha256: contentHash({ findings: out.findings, flags: out.flags }),
    ...(out.sourceVerification ? { sourceVerification: out.sourceVerification } : {}),
    ...(out.notMeasurable ? { notMeasurable: out.notMeasurable } : {}),
    ...(out.symptoms ? { symptoms: out.symptoms } : {}),
    ...over,
  };
}

export function vitals(mutate: (r: any) => void = () => {}) {
  const r = JSON.parse(JSON.stringify(example)); delete r.subject.identity; mutate(r);
  const doc = docFrom(beaiveAdapter.run(r as StoredRequest), 'beaive-v1');
  return { doc, gov: governFindings(doc, BEAIVE_GOVERNANCE, NOW), ctx: BEAIVE_GOVERNANCE };
}

export function posture(mode: 'unsigned' | 'signed' = 'unsigned', mutate: (f: ReturnType<typeof syntheticPosture>) => void = () => {}) {
  process.env.ANUCLAW_POSTUREPULSE_IMPORT_SECRET ||= 'import-secret-'.padEnd(40, 'z');
  const f = syntheticPosture(); mutate(f);
  const req = {
    schemaVersion: 'interpretation-request/v1', skillId: 'posture-analysis-interpretation', analysisType: 'posture_landmark', subject: { externalRef: f.session.subjectPseudoId },
    acquisition: { capturedAt: new Date().toISOString() }, source: { application: 'PosturePulse', modelName: 'm', modelVersion: '0' },
    nativePayload: mode === 'signed' ? { format: POSTUREPULSE_FORMAT, bundle: signBundle(bundlePayloadOf(f) as any, process.env.ANUCLAW_POSTUREPULSE_IMPORT_SECRET as string) }
      : { format: POSTUREPULSE_FORMAT, unsigned: { consentRecord: f.consentRecord, session: f.session, report: f.report, symptomReports: f.symptomReports } },
  } as StoredRequest;
  const prepared = posturepulseAdapter.prepare!(req);
  const doc = docFrom(posturepulseAdapter.run(prepared), 'posturepulse-v1', { provenance: { adapter: { id: 'posturepulse-v1', version: '1.0.0' }, sourceModel: { application: 'PosturePulse' }, ruleset: { id: 'intake-normalisation', version: '1.0.0' }, originalPayloadSha256: 'b'.repeat(64) } });
  return { doc, gov: governFindings(doc, EMPTY_CONTEXT as GovernanceContext, NOW) };
}
