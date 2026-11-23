/** Report assembly, rendering and branding (interpretation engine, P4c). Pure: no database, no model. Synthetic data only. */
import { describe, expect, it } from 'vitest';
import { deterministicNarrative } from '../narrative/deterministic';
import { posture, vitals } from '../narrative/fixtures';
import type { Narrative } from '../narrative/types';
import { ADVISORY } from './advisory';
import { assembleLayers } from './assemble';
import { MAX_LOGO_BYTES, parseBrandingUpdate, sniffImage } from './branding';
import { bannerFor, esc, governanceStatement, renderReportHtml } from './render';
import { TenancyError } from '../tenancy/keys';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

function build(f: ReturnType<typeof vitals> = vitals(), narrativeFlags: any[] = []) {
  const narratives = { clinical: deterministicNarrative('clinical', f.doc, f.gov), layman: deterministicNarrative('layman', f.doc, f.gov) } as Record<'clinical' | 'layman', Narrative>;
  return assembleLayers({ doc: f.doc, gov: f.gov, narratives, narrativeFlags, governanceSha256: 'b'.repeat(64), meta: { reportId: 'rpt_x', version: 1, narrativeMode: 'deterministic', modelRequested: null, modelReturned: null, promptVersions: { clinical: 'clinical-vitals/v1', layman: 'layman-vitals/v1' } } });
}

describe('assembly: two layers, one set of findings', () => {
  it('both layers are built from the same findings: same rows, same hashes, same flags and advisory decision', () => {
    const f = vitals(); const { clinical, layman } = build(f);
    expect(clinical.findings).toEqual(layman.findings);
    expect(clinical.traceability.findingsSha256).toBe(f.doc.findingsSha256);
    expect(layman.traceability.findingsSha256).toBe(clinical.traceability.findingsSha256);
    expect(clinical.flags.map((x) => [x.type, x.severity])).toEqual(layman.flags.map((x) => [x.type, x.severity]));
    expect(clinical.referral !== null).toBe(layman.referral !== null);
    expect(clinical.layer).toBe('clinical'); expect(layman.layer).toBe('layman');
  });

  it('is deterministic: the same inputs give byte-identical layers', () => {
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  it('the referral advisory is the fixed text from code in BOTH layers, never the narrative', () => {
    const f = vitals(); expect(f.gov.referral).not.toBeNull();
    const { clinical, layman } = build(f);
    expect(clinical.referral).toMatchObject({ text: ADVISORY.clinical, safetyNet: null, advisory: { id: ADVISORY.id, version: ADVISORY.version } });
    expect(layman.referral).toMatchObject({ text: ADVISORY.layman, safetyNet: ADVISORY.safetyNet });
    expect(clinical.referral!.reasonCodes.length).toBeGreaterThan(0);
  });

  it('no advisory when governance triggered none', () => {
    const f = posture('signed'); expect(f.gov.referral).toBeNull();
    const { clinical, layman } = build(f);
    expect(clinical.referral).toBeNull(); expect(layman.referral).toBeNull();
    expect(clinical.traceability.advisory).toBeNull();
  });

  it('positions come from governance, values and units from the findings, nothing recomputed', () => {
    const f = vitals(); const { clinical } = build(f);
    for (const row of clinical.findings) {
      const p = f.gov.positions.find((x) => x.findingKey === row.key)!;
      expect(row.position).toBe(p.position); expect(row.positionBasis).toBe(p.basis);
      const src = f.doc.findings.find((x) => x.findingKey === row.key)!;
      if (!src.excluded) expect(row.value).toBe(src.value);
    }
  });

  it('an excluded finding shows its reason and NO value', () => {
    const f = vitals((r) => { r.findings[0].excluded = { reason: 'poor_signal_quality_zq' }; });
    const { clinical } = build(f);
    const row = clinical.findings.find((x) => x.valueStatus === 'excluded')!;
    expect(row).toMatchObject({ value: null, excludedReason: 'poor_signal_quality_zq' });
    expect(row.referenceText).toBeUndefined();
  });

  it('flag prose: Clinical keeps the flag detail, Layman only ever gets the fixed plain sentence', () => {
    const f = posture('unsigned'); const { clinical, layman } = build(f);
    const blocking = f.doc.flags.find((x) => x.type === 'unverified_source')!;
    expect(clinical.flags.find((x) => x.type === 'unverified_source')!.text).toContain(blocking.detail);
    expect(layman.flags.find((x) => x.type === 'unverified_source')!.text).not.toContain(blocking.detail);
    expect(layman.flags.find((x) => x.type === 'unverified_source')!.text).toMatch(/could not check where this report came from/i);
  });

  it('flags added by the narrative stage (review_required) are shown, not dropped', () => {
    const { clinical, layman } = build(vitals(), [{ type: 'review_required', severity: 'attention', detail: 'x' }]);
    expect(clinical.flags.some((x) => x.type === 'review_required')).toBe(true); expect(layman.flags.some((x) => x.type === 'review_required')).toBe(true);
  });

  it('the traceability block names the source, adapter, rulesets, model and prompt, advisory and all three hashes', () => {
    const f = vitals(); const t = build(f).clinical.traceability;
    expect(t).toMatchObject({ reportId: 'rpt_x', version: 1, findingsSha256: f.doc.findingsSha256, governanceSha256: 'b'.repeat(64), originalPayloadSha256: 'a'.repeat(64), application: 'beAIve', adapter: { id: 'beaive-v1' }, narrativeMode: 'deterministic', promptVersion: 'clinical-vitals/v1' });
    expect(t.governanceRuleset.id).toBe('governance-ruleset'); expect(t.advisory).toMatchObject({ id: ADVISORY.id, version: ADVISORY.version });
  });
});

describe('rendering', () => {
  const f = vitals(); const { clinical, layman } = build(f);

  it('every page carries the fixed governance statement and the status banner; the banner follows the review state', () => {
    for (const d of [clinical, layman]) {
      const html = renderReportHtml(d, { state: 'ai_reviewed' });
      for (const p of governanceStatement(d.layer)) expect(html).toContain(esc(p));
      expect(html).toContain('AI-reviewed, not reviewed by a clinician');
      expect(html).toMatch(/not a diagnosis/i);
    }
    expect(bannerFor({ state: 'awaiting_clinician' }).text).toMatch(/^Awaiting clinician review/);
    expect(bannerFor({ state: null }).text).toMatch(/not reviewed by a clinician/);
    expect(bannerFor({ state: 'rejected' }).tone).toBe('bad');
    expect(bannerFor({ state: 'clinician_signed', reviewedBy: 'Dr Synthetic', reviewedAt: Date.parse('2026-08-21T10:00:00Z') }).text).toBe('Signed by Dr Synthetic, 2026-08-21.');
  });

  it('the governance statement and banner are visible: nothing hides them (no hidden attribute, no display:none outside the print rules)', () => {
    for (const d of [clinical, layman]) {
      const html = renderReportHtml(d, { state: null });
      expect(html).toContain('<section class="gov">'); expect(html).toContain('<div class="banner ');
      expect(html).not.toMatch(/\bhidden\b|display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0/i);
    }
  });

  it('the advisory block and the safety net are in the page whenever governance triggered an advisory', () => {
    expect(renderReportHtml(clinical, { state: null })).toContain(esc(ADVISORY.clinical));
    const lay = renderReportHtml(layman, { state: null });
    expect(lay).toContain(esc(ADVISORY.layman)); expect(lay).toContain(esc(ADVISORY.safetyNet));
    const none = build(posture('signed'));
    expect(renderReportHtml(none.layman, { state: null })).not.toContain(esc(ADVISORY.layman));
  });

  it('branding changes only the name and logo: the governance block, banner and advisory cannot be removed or altered by it', () => {
    const plain = renderReportHtml(layman, { state: 'ai_reviewed' });
    const branded = renderReportHtml(layman, { state: 'ai_reviewed' }, { productName: 'Acme Health', logoMime: 'image/png', logoBase64: PNG.toString('base64') });
    expect(branded).toContain('Acme Health'); expect(branded).toContain('data:image/png;base64,');
    const strip = (h: string) => h.replace(/<header class="brand">[\s\S]*?<\/header>/, '');
    expect(strip(branded)).toBe(strip(plain));
  });

  it('escapes everything: markup in the product name, a finding label, a flag detail and a section never becomes markup', () => {
    const evil = '<script>alert(1)</script>"\'`&';
    const d = JSON.parse(JSON.stringify(clinical));
    d.findings[0].label = `L${evil}`; d.sections[0].text = `S${evil}`; d.flags.push({ type: 'x', severity: 'attention', text: `F${evil}` }); d.limitations = `Z${evil}`;
    d.findings[0].referenceText = `R${evil}`; d.findings[0].unit = `U${evil}`;
    const html = renderReportHtml(d, { state: null, reviewedBy: evil }, { productName: evil });
    expect(html).not.toContain('<script'); expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain('&lt;script&gt;');
    expect(renderReportHtml(d, { state: 'clinician_signed', reviewedBy: evil, reviewedAt: 1 }, {})).not.toContain('<script');
  });

  it('is a self-contained page: no script, no external resource, no link', () => {
    for (const d of [clinical, layman]) {
      const html = renderReportHtml(d, { state: 'ai_reviewed' }, { productName: 'Acme', logoMime: 'image/jpeg', logoBase64: JPG.toString('base64') });
      expect(html).not.toMatch(/<script|<iframe|<link |<object|<embed|<form|@import|https?:\/\//i);
      for (const m of html.matchAll(/\b(?:src|href)="([^"]*)"/g)) expect(m[1].startsWith('data:image/')).toBe(true);
    }
  });

  it('Layman page: no clinical jargon columns, no hashes beyond a short fingerprint, no tenant or job ids', () => {
    const html = renderReportHtml(layman, { state: null });
    expect(html).not.toContain(f.doc.findingsSha256); expect(html).not.toContain(f.doc.tenantId); expect(html).not.toContain(f.doc.jobId);
    expect(html).toContain(f.doc.findingsSha256.slice(0, 16));
  });

  it('Clinical page: the full traceability block with every hash', () => {
    const html = renderReportHtml(clinical, { state: null });
    for (const h of [f.doc.findingsSha256, 'b'.repeat(64), 'a'.repeat(64)]) expect(html).toContain(h);
    expect(html).toContain('referral-advisory');
  });

  it('the subject reference never appears in either layer', () => {
    for (const d of [clinical, layman]) expect(JSON.stringify(d) + renderReportHtml(d, { state: null })).not.toContain(f.doc.subjectRef);
  });
});

describe('branding validation', () => {
  const ok = (b: unknown) => parseBrandingUpdate(b);
  const bad = (b: unknown) => { try { parseBrandingUpdate(b); } catch (e) { expect(e).toBeInstanceOf(TenancyError); expect((e as TenancyError).status).toBe(400); return; } throw new Error('expected a 400'); };

  it('accepts a plain product name and trims it', () => { expect(ok({ productName: '  Acme Health (UK), Ltd. ' }).productName).toBe('Acme Health (UK), Ltd.'); });
  it.each(['', '   ', '<b>x</b>', 'a'.repeat(61), 'x\nY', 'a;b', 'a/b', '{{x}}', 'x\u0000y', '-leading dash'])('refuses the product name %j', (n) => bad({ productName: n }));
  it('null clears a field; nothing at all is refused; unknown fields are refused', () => { expect(ok({ productName: null, logoBase64: null })).toEqual({ productName: null, logo: null }); bad({}); bad({ productName: 'A', footer: 'x' }); bad({ productName: 'A', governance: 'off' }); });
  it('accepts PNG and JPEG, deciding the type from the bytes', () => {
    expect(ok({ logoBase64: PNG.toString('base64') }).logo!.mime).toBe('image/png');
    expect(ok({ logoBase64: JPG.toString('base64') }).logo!.mime).toBe('image/jpeg');
  });
  it('refuses SVG, GIF, text, empty, oversized and non-base64 logos', () => {
    bad({ logoBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64') });
    bad({ logoBase64: Buffer.from('GIF89a....').toString('base64') });
    bad({ logoBase64: Buffer.from('hello').toString('base64') });
    bad({ logoBase64: '' }); bad({ logoBase64: 'not base64!!' }); bad({ logoBase64: 'data:image/png;base64,AAAA' }); bad({ logoBase64: 42 });
    bad({ logoBase64: Buffer.concat([PNG, Buffer.alloc(MAX_LOGO_BYTES)]).toString('base64') });
  });
  it('sniffs by magic bytes only', () => { expect(sniffImage(PNG)).toBe('image/png'); expect(sniffImage(JPG)).toBe('image/jpeg'); expect(sniffImage(Buffer.from('<svg'))).toBeNull(); expect(sniffImage(Buffer.alloc(0))).toBeNull(); });
});
