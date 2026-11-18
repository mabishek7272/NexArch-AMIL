/**
 * SOAP draft, plain-language explanation and HTML export from ONE approved
 * snapshot (plan §7.3–7.4). Deterministic: nothing is invented to fill a section.
 *
 *  S — only supplied patient/clinician history; otherwise "Not provided".
 *  O — confirmed observations with source page and method.
 *  A — rule findings restated neutrally; explicitly no diagnosis.
 *  P — "Not provided"; plans come from the treating clinician.
 */
import { Finding, ObservationInput, RuleRunOutput } from './rules';

export interface SnapshotObservation extends ObservationInput {
  method: string;
  revision: number;
  status: 'confirmed' | 'corrected';
}

export interface ReportInput {
  snapshotId: string;
  snapshotHash: string;
  ruleRunId: string;
  ruleRunOutputHash: string;
  rules: RuleRunOutput;
  observations: SnapshotObservation[];
  subjective?: Array<{ text: string; source: string; date: string }>;
  documentLabel: string;
  createdAt: string;
}

export interface StructuredReport {
  version: 'report-v1';
  status: 'draft';
  soap: {
    subjective: { provided: boolean; items: Array<{ text: string; source: string; date: string }>; note?: string };
    objective: { items: Array<{ observationId: string; text: string; source: string }> };
    assessment: { items: Array<{ observationId: string; text: string; ruleId: string; ruleVersion: string }>; note: string; clinicalRules: string };
    plan: { provided: false; note: string };
  };
  layman: { items: string[]; limitations: string[]; questions: string[] };
  provenance: { snapshotId: string; snapshotHash: string; ruleRunId: string; ruleRunOutputHash: string; engineVersion: string; createdAt: string };
}

const fmtObs = (o: SnapshotObservation) => `${o.analyte}: ${o.valueRaw}${o.unit ? ` ${o.unit}` : ' (unit not stated)'}${o.refLow !== null && o.refHigh !== null ? ` (report interval ${o.refLow}–${o.refHigh})` : ''}`;
const src = (o: SnapshotObservation) => `${o.page !== null ? `page ${o.page}` : 'page unknown'}, ${o.method}${o.status === 'corrected' ? `, corrected (rev ${o.revision})` : ''}`;

function laymanFor(o: SnapshotObservation, f: Finding | undefined): string {
  const v = `${o.valueRaw}${o.unit ? ` ${o.unit}` : ''}`;
  switch (f?.result) {
    case 'outside_reported_interval_high': return `Your report lists ${o.analyte} as ${v}. That is above the range printed by the laboratory (${o.refLow}–${o.refHigh}). A value outside this range does not by itself mean you have a particular condition; your clinician will interpret it with your history.`;
    case 'outside_reported_interval_low': return `Your report lists ${o.analyte} as ${v}. That is below the range printed by the laboratory (${o.refLow}–${o.refHigh}). A value outside this range does not by itself mean you have a particular condition; your clinician will interpret it with your history.`;
    case 'within_reported_interval': return `Your report lists ${o.analyte} as ${v}, which is within the range printed by the laboratory (${o.refLow}–${o.refHigh}).`;
    default: return `Your report lists ${o.analyte} as ${v}. ${f?.reason ?? 'No comparison was made.'}`;
  }
}

export function buildReport(input: ReportInput): StructuredReport {
  const findingsByObs = new Map(input.rules.findings.map((f) => [f.observationId, f]));
  const subj = input.subjective ?? [];
  const outside = input.rules.findings.filter((f) => f.result.startsWith('outside'));
  return {
    version: 'report-v1',
    status: 'draft',
    soap: {
      subjective: subj.length
        ? { provided: true, items: subj }
        : { provided: false, items: [], note: 'Not provided — no patient- or clinician-reported history was supplied with this document.' },
      objective: { items: input.observations.map((o) => ({ observationId: o.id, text: fmtObs(o), source: src(o) })) },
      assessment: {
        items: input.rules.findings
          .filter((f) => f.result !== 'within_reported_interval')
          .map((f) => ({ observationId: f.observationId, text: f.reason, ruleId: f.ruleId, ruleVersion: f.ruleVersion })),
        note: 'Comparisons use only the reference intervals printed on the source report. No diagnosis or clinical assessment has been made.',
        clinicalRules: input.rules.clinicalState === 'no_released_rules'
          ? 'No clinical rules are released in this deployment; no clinical thresholds were applied.'
          : 'Released clinical rules were evaluated (see findings).',
      },
      plan: { provided: false, note: 'Not provided — any plan must come from the treating clinician.' },
    },
    layman: {
      items: input.observations.map((o) => laymanFor(o, findingsByObs.get(o.id))),
      limitations: [
        'This summary restates values from your document; it is not a diagnosis.',
        'Laboratory ranges differ between laboratories and are not the same as treatment thresholds.',
        ...(input.observations.some((o) => o.method === 'ocr') ? ['Some values were read from a scanned image and then confirmed by a reviewer.'] : []),
        'Symptoms, history and examination were not available to this summary.',
      ],
      questions: [
        ...(outside.length ? ['What do the values outside the laboratory range mean for me?'] : []),
        'Do any of these results need repeating or follow-up?',
        'How do these results fit with my symptoms and history?',
      ],
    },
    provenance: {
      snapshotId: input.snapshotId, snapshotHash: input.snapshotHash, ruleRunId: input.ruleRunId,
      ruleRunOutputHash: input.ruleRunOutputHash, engineVersion: input.rules.engineVersion, createdAt: input.createdAt,
    },
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function renderReportHtml(r: StructuredReport, meta: { reportId: string; version: number; status: string; reviewedBy?: string | null }): string {
  const li = (xs: string[]) => xs.map((x) => `<li>${esc(x)}</li>`).join('');
  const statusLabel = meta.status === 'reviewed' ? `Reviewed${meta.reviewedBy ? ` by ${esc(meta.reviewedBy)}` : ''}` : meta.status === 'superseded' ? 'SUPERSEDED — do not use' : 'DRAFT — not reviewed';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Report ${esc(meta.reportId)} v${meta.version}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#111}
.status{padding:.5rem .75rem;border:2px solid #b45309;background:#fef3c7;font-weight:600}.status.reviewed{border-color:#047857;background:#d1fae5}
h2{border-bottom:1px solid #ddd;padding-bottom:.25rem}.src{color:#555;font-size:.85em}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.35rem;text-align:left}
@media print{.status{border-width:1px}}</style></head><body>
<p class="status ${meta.status === 'reviewed' ? 'reviewed' : ''}" role="status">${statusLabel} · version ${meta.version}</p>
<h1>Clinician view (SOAP)</h1>
<h2>Subjective</h2>${r.soap.subjective.provided ? `<ul>${r.soap.subjective.items.map((i) => `<li>${esc(i.text)} <span class="src">(${esc(i.source)}, ${esc(i.date)})</span></li>`).join('')}</ul>` : `<p>${esc(r.soap.subjective.note)}</p>`}
<h2>Objective</h2><table><thead><tr><th>Value</th><th>Source</th></tr></thead><tbody>${r.soap.objective.items.map((i) => `<tr><td>${esc(i.text)}</td><td class="src">${esc(i.source)}</td></tr>`).join('') || '<tr><td colspan="2">No confirmed observations.</td></tr>'}</tbody></table>
<h2>Assessment</h2><ul>${li(r.soap.assessment.items.map((i) => `${i.text} [${i.ruleId}@${i.ruleVersion}]`))}</ul><p>${esc(r.soap.assessment.note)}</p><p>${esc(r.soap.assessment.clinicalRules)}</p>
<h2>Plan</h2><p>${esc(r.soap.plan.note)}</p>
<h1>Plain-language summary</h1><ul>${li(r.layman.items)}</ul>
<h3>Limitations</h3><ul>${li(r.layman.limitations)}</ul><h3>Questions for your clinician</h3><ul>${li(r.layman.questions)}</ul>
<h2>Provenance</h2><p class="src">Snapshot ${esc(r.provenance.snapshotId)} (sha256 ${esc(r.provenance.snapshotHash)}) · rule run ${esc(r.provenance.ruleRunId)} (output sha256 ${esc(r.provenance.ruleRunOutputHash)}) · ${esc(r.provenance.engineVersion)} · created ${esc(r.provenance.createdAt)}</p>
</body></html>`;
}
