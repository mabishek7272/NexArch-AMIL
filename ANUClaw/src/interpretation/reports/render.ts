/**
 * Report rendering (interpretation engine, P4c): a stored layer document -> one self-contained HTML page.
 *
 * Every piece of variable text goes through `esc()`; there is no raw-HTML path, no script, no external resource. The
 * only things a tenant can influence are the product name (charset-limited) and a PNG/JPEG logo (sniffed, embedded as
 * a data: URI). The status banner, the governance statement and the referral advisory are generated here from code and
 * are not part of the stored content or the branding.
 */
import type { Layer } from '../narrative/types';
import type { ReportFindingRow, ReportLayerDoc } from './assemble';

export interface Branding { productName?: string | null; logoMime?: 'image/png' | 'image/jpeg' | null; logoBase64?: string | null }
export type ReviewState = 'ai_reviewed' | 'awaiting_clinician' | 'clinician_signed' | 'rejected' | null;
export interface ReviewInfo { state: ReviewState; reviewedBy?: string | null; reviewedAt?: number | null; rejectionReason?: string | null }

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c] as string));
}

/** The status banner. Fixed wording per state; the signer's name and date appear only for a signed report. */
export function bannerFor(r: ReviewInfo): { text: string; tone: 'info' | 'warn' | 'ok' | 'bad' } {
  switch (r.state) {
    case 'clinician_signed': {
      const when = r.reviewedAt ? new Date(Number(r.reviewedAt)).toISOString().slice(0, 10) : '';
      return { text: `Signed by ${r.reviewedBy ?? 'a named clinician'}${when ? `, ${when}` : ''}.`, tone: 'ok' };
    }
    case 'ai_reviewed': return { text: 'AI-reviewed, not reviewed by a clinician. This report is not a diagnosis.', tone: 'info' };
    case 'awaiting_clinician': return { text: 'Awaiting clinician review. This report is not a diagnosis and should not be relied on until a clinician has reviewed it.', tone: 'warn' };
    case 'rejected': return { text: 'A clinician rejected this version. Do not rely on it; see the newer version.', tone: 'bad' };
    default: return { text: 'Automated draft, not reviewed by a clinician. This report is not a diagnosis.', tone: 'info' };
  }
}

/** The governance statement: fixed text, identical for every tenant and layer-specific only in register. */
export function governanceStatement(layer: Layer): string[] {
  return layer === 'clinical'
    ? [
      'This report was produced by an automated interpretation service. Values, units and reference ranges are those supplied by the source application and are reproduced without endorsement.',
      'Positions relative to a reference are computed by fixed rules from the supplied reference only. Explanatory text is limited to the supplied findings and is checked automatically; it does not diagnose, reassure or recommend treatment.',
      'The source is not a validated diagnostic device. Nothing here replaces clinical assessment, validated measurement or professional judgement.',
    ]
    : [
      'This report explains results from an app. It is made by an automated service using fixed rules, and it only uses what the app reported.',
      'It is not a diagnosis, and it does not say whether you are healthy or unwell. Only a doctor or another qualified health professional can do that.',
      'Please do not start, stop or change any medicine because of this report.',
    ];
}

const POSITION_CLINICAL: Record<string, string> = {
  below: 'Below reference', within: 'Within reference', above: 'Above reference', indeterminate: 'Indeterminate',
  no_reference: 'No reference', not_applicable: 'Not applicable',
};
const POSITION_LAYMAN: Record<string, string> = {
  below: 'Below the app’s range', within: 'Inside the app’s range', above: 'Above the app’s range', indeterminate: 'Too close to the edge to tell',
  no_reference: 'No range to compare with', not_applicable: 'Not compared',
};
const STATUS_LABEL: Record<string, string> = { source_finding: 'Reported by the source', interpretation: 'Explanation', limitation: 'Limitation' };
const BASIS_CLINICAL: Record<string, string> = {
  numeric_reference: 'numeric reference', uncertainty_straddles_bound: 'uncertainty crosses a bound', boundary_inclusivity_unstated: 'boundary inclusivity unstated',
  draft_reference: 'draft reference, not used', text_only_reference: 'text-only reference', no_reference: 'no reference', non_numeric_value: 'non-numeric value',
  missing_value: 'no value', excluded: 'excluded by the source',
};

const CSS = `
:root{--ink:#17202a;--mute:#566573;--line:#d5dbe1;--bg:#fff;--soft:#f4f6f8;--info:#1f4e79;--info-bg:#e8f1fa;--warn:#7a4b00;--warn-bg:#fff4dc;--ok:#1e5b34;--ok-bg:#e6f4ea;--bad:#7b1e1e;--bad-bg:#fbe9e9}
@media (prefers-color-scheme:dark){:root{--ink:#e8edf2;--mute:#a6b2bd;--line:#38424c;--bg:#12171c;--soft:#1b222a;--info:#9cc4ea;--info-bg:#16283a;--warn:#f1c27a;--warn-bg:#33270f;--ok:#9bd7ae;--ok-bg:#12281a;--bad:#f1a0a0;--bad-bg:#341515}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:0 16px 40px}
.banner{position:sticky;top:0;z-index:5;padding:10px 16px;font-weight:600;border-bottom:1px solid var(--line)}
.banner.info{background:var(--info-bg);color:var(--info)}.banner.warn{background:var(--warn-bg);color:var(--warn)}.banner.ok{background:var(--ok-bg);color:var(--ok)}.banner.bad{background:var(--bad-bg);color:var(--bad)}
header.brand{display:flex;align-items:center;gap:14px;padding:18px 0 10px;border-bottom:1px solid var(--line)}header.brand img{max-height:48px;max-width:160px}
h1{font-size:1.45rem;margin:.2rem 0}h2{font-size:1.1rem;margin:1.6rem 0 .5rem}.meta{color:var(--mute);font-size:.88rem}
.advisory{border:2px solid var(--warn);background:var(--warn-bg);color:var(--ink);border-radius:8px;padding:12px 14px;margin:16px 0}.advisory h2{margin:0 0 6px;color:var(--warn)}
.gov{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:16px 0;font-size:.92rem}
table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:600}
.table-wrap{overflow-x:auto}.tag{display:inline-block;font-size:.75rem;border:1px solid var(--line);border-radius:10px;padding:0 7px;color:var(--mute);margin-right:6px}
.sev-blocking{font-weight:700}ul{padding-left:1.2rem}.trace{font-size:.8rem;color:var(--mute);word-break:break-word}.trace dt{font-weight:600;float:left;clear:left;margin-right:6px}.trace dd{margin:0 0 2px}
@media print{.banner{position:static}.wrap{max-width:none}}
`;

function valueCell(f: ReportFindingRow, layer: Layer): string {
  if (f.valueStatus === 'excluded') return layer === 'clinical' ? `Excluded: ${esc(f.excludedReason)}` : 'Not used';
  if (f.value === null) return layer === 'clinical' ? 'No value reported' : 'Could not be measured';
  return `${esc(f.value)}${f.unit ? ` ${esc(f.unit)}` : ''}${f.uncertainty && layer === 'clinical' ? ` <span class="meta">(${esc(f.uncertainty)})</span>` : ''}`;
}

function findingsTable(d: ReportLayerDoc): string {
  const clin = d.layer === 'clinical';
  const head = clin ? ['Finding', 'Value', 'Source reference', 'Position', 'Source flag', 'Notes'] : ['Result', 'Your value', 'The app’s range', 'Compared with the range'];
  const rows = d.findings.map((f) => {
    const pos = (clin ? POSITION_CLINICAL : POSITION_LAYMAN)[f.position] ?? esc(f.position);
    const ref = f.valueStatus === 'excluded' ? '' : f.referenceText ? `${esc(f.referenceText)}${f.referenceDraft ? ' <span class="tag">draft</span>' : ''}` : '–';
    const label = `${esc(f.label)}${f.side ? ` <span class="meta">(${esc(f.side)})</span>` : ''}`;
    if (!clin) return `<tr><td>${label}</td><td>${valueCell(f, d.layer)}</td><td>${ref}</td><td>${esc(pos)}</td></tr>`;
    const notes = [
      f.tier ? `tier: ${f.tier}` : '', f.underResearch ? 'under research' : '', BASIS_CLINICAL[f.positionBasis] ? `basis: ${BASIS_CLINICAL[f.positionBasis]}` : '',
      f.unsupportedReasons?.length ? `unsupported: ${f.unsupportedReasons.join(', ')}` : '',
    ].filter(Boolean).map(esc).join('; ');
    return `<tr><td>${label}</td><td>${valueCell(f, d.layer)}</td><td>${ref}</td><td>${esc(pos)}</td><td>${esc(f.sourceFlag ?? '–')}</td><td>${notes}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function traceability(d: ReportLayerDoc): string {
  const t = d.traceability; const clin = d.layer === 'clinical';
  const items: Array<[string, string | undefined | null]> = clin
    ? [
      ['Report', `${t.reportId} (version ${t.version})`], ['Job', t.jobId], ['Tenant', t.tenantId],
      ['Source', `${t.application}${t.applicationVersion ? ` ${t.applicationVersion}` : ''}, model ${t.modelName} ${t.modelVersion}${t.calibrationVersion ? `, calibration ${t.calibrationVersion}` : ''}`],
      ['Research status', t.researchStatus], ['Source verification', t.verification], ['Adapter', `${t.adapter.id} ${t.adapter.version}`],
      ['Rulesets', `${t.intakeRuleset.id} ${t.intakeRuleset.version}; ${t.governanceRuleset.id} ${t.governanceRuleset.version}`],
      ['Explanation text', t.narrativeMode === 'deterministic' ? 'fixed templates (no model)' : `${t.narrativeMode}; model requested ${t.modelRequested ?? '–'}, returned ${t.modelReturned ?? '–'}; prompt ${t.promptVersion ?? '–'}`],
      ['Referral advisory', t.advisory ? `${t.advisory.id} ${t.advisory.version}` : 'not triggered'],
      ['Findings SHA-256', t.findingsSha256], ['Governance SHA-256', t.governanceSha256], ['Original payload SHA-256', t.originalPayloadSha256],
    ]
    : [['Report', t.reportId], ['Made from', `${t.application} (${t.modelName} ${t.modelVersion})`], ['Findings fingerprint', t.findingsSha256.slice(0, 16)]];
  return `<h2>${clin ? 'Traceability' : 'About this report'}</h2><dl class="trace">${items.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}:</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

export function renderReportHtml(d: ReportLayerDoc, review: ReviewInfo, branding: Branding = {}): string {
  const clin = d.layer === 'clinical';
  const banner = bannerFor(review);
  const name = branding.productName ? esc(branding.productName) : '';
  const logo = branding.logoBase64 && branding.logoMime ? `<img alt="${name ? `${name} logo` : 'Logo'}" src="data:${esc(branding.logoMime)};base64,${esc(branding.logoBase64)}">` : '';
  const title = clin ? 'Clinical report' : 'Your results explained';
  const sections = d.sections.map((s) => `<p><span class="tag">${esc(STATUS_LABEL[s.statusLabel] ?? s.statusLabel)}</span>${esc(s.text)}</p>`).join('');
  const ref = d.referral
    ? `<section class="advisory" role="note"><h2>${clin ? 'Referral advisory' : 'Please see a doctor'}</h2><p>${esc(d.referral.text)}</p>${d.referral.safetyNet ? `<p><strong>${esc(d.referral.safetyNet)}</strong></p>` : ''}</section>`
    : '';
  const flags = d.flags.length ? `<h2>${clin ? 'Flags' : 'Things to know about these results'}</h2><ul>${d.flags.map((f) => `<li${f.severity === 'blocking' ? ' class="sev-blocking"' : ''}>${clin ? `<span class="tag">${esc(f.severity)}</span>` : ''}${esc(f.text)}</li>`).join('')}</ul>` : '';
  const nm = d.notMeasurable.length ? `<h2>${clin ? 'Not measurable from this capture' : 'What this app could not measure'}</h2><ul>${d.notMeasurable.map((n) => `<li>${esc(n.label)}${clin ? `: ${esc(n.reason)}. Needed: ${esc(n.whatWouldBeNeeded)}` : ''}</li>`).join('')}</ul>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>
<div class="banner ${banner.tone}" role="status">${esc(banner.text)}</div>
<div class="wrap">
<header class="brand">${logo}<div>${name ? `<div class="meta">${name}</div>` : ''}<h1>${esc(title)}</h1><div class="meta">Captured ${esc(d.capturedAt)} &middot; ${esc(d.traceability.application)}</div></div></header>
${ref}
<section class="gov"><strong>Governance</strong>${governanceStatement(d.layer).map((p) => `<p>${esc(p)}</p>`).join('')}</section>
<h2>${clin ? 'Findings' : 'Your results'}</h2>${findingsTable(d)}
<h2>${clin ? 'Summary' : 'What this means'}</h2>${sections}
${flags}${nm}
<h2>${clin ? 'Recommended next steps' : 'What to do next'}</h2><ul>${d.nextSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
<h2>Limitations</h2><p>${esc(d.limitations)}</p>
${traceability(d)}
</div></body></html>`;
}
