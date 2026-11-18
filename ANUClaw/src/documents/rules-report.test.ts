import { describe, expect, it } from 'vitest';
import { REPORTED_INTERVAL_RULE, RuleDefinition, isReleased, runRules, sha256, canonicalJson } from './rules';
import { buildReport, renderReportHtml, SnapshotObservation } from './report';

const o = (id: string, valueRaw: string, valueNum: number | null, refLow: number | null, refHigh: number | null, comparator: string | null = null): SnapshotObservation => ({
  id, analyte: `Analyte ${id}`, valueRaw, valueNum, comparator, unit: 'u', refLow, refHigh, page: 1, method: 'native_text', revision: 1, status: 'confirmed',
});

describe('rules', () => {
  it('compares only against the printed interval, with explicit states', () => {
    const r = runRules([o('a', '16', 16, 12, 15.5), o('b', '10', 10, 12, 15.5), o('c', '13', 13, 12, 15.5), o('d', '13', 13, null, null), o('e', '1,2', null, 1, 2)]);
    expect(r.findings.map((f) => f.result)).toEqual([
      'outside_reported_interval_high', 'outside_reported_interval_low', 'within_reported_interval', 'insufficient_data', 'not_comparable',
    ]);
  });

  it('handles inequality values conservatively', () => {
    const r = runRules([o('a', '<0.01', 0.01, 0.01, 0.04, '<'), o('b', '<0.02', 0.02, 0.01, 0.04, '<'), o('c', '>100', 100, 10, 50, '>')]);
    expect(r.findings.map((f) => f.result)).toEqual(['outside_reported_interval_low', 'not_comparable', 'outside_reported_interval_high']);
  });

  it('ships no released clinical rules and says so', () => {
    expect(runRules([]).clinicalState).toBe('no_released_rules');
  });

  it('an unapproved clinical rule is not released and never runs', () => {
    let ran = false;
    const draft: RuleDefinition = { id: 'x', version: '0', title: 't', category: 'clinical', source: 's', evaluate: () => { ran = true; return []; } };
    expect(isReleased(draft)).toBe(false);
    const r = runRules([o('a', '1', 1, 0, 2)], [REPORTED_INTERVAL_RULE, draft]);
    expect(ran).toBe(false);
    expect(r.rules.find((x) => x.id === 'x')?.released).toBe(false);
  });

  it('hashing is canonical (key order independent)', () => {
    expect(sha256({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(sha256({ b: [2, { d: 4, c: 3 }], a: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe('report', () => {
  const obs = [o('a', '16', 16, 12, 15.5), o('b', '13', 13, 12, 15.5)];
  const rules = runRules(obs);
  const report = buildReport({ snapshotId: 's1', snapshotHash: 'h1', ruleRunId: 'r1', ruleRunOutputHash: 'o1', rules, observations: obs, documentLabel: 'doc', createdAt: '2026-11-17T00:00:00Z' });

  it('keeps missing SOAP sections explicit and invents nothing', () => {
    expect(report.soap.subjective.provided).toBe(false);
    expect(report.soap.subjective.note).toMatch(/Not provided/);
    expect(report.soap.plan.note).toMatch(/Not provided/);
    expect(report.soap.assessment.note).toMatch(/No diagnosis/);
    expect(report.soap.assessment.clinicalRules).toMatch(/No clinical rules are released/);
  });

  it('every displayed number comes from the snapshot', () => {
    const allText = [
      ...report.soap.objective.items.flatMap((i) => [i.text, i.source]),
      ...report.soap.assessment.items.map((i) => i.text),
      ...report.layman.items,
    ].join(' ');
    const nums = new Set((allText.match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
    const allowed = new Set([16, 13, 12, 15.5, 1]); // values, interval bounds, page numbers
    for (const n of nums) expect(allowed.has(n)).toBe(true);
  });

  it('layman text does not turn a flagged value into a diagnosis', () => {
    expect(report.layman.items[0]).toMatch(/does not by itself mean/);
    expect(report.layman.items.join(' ')).not.toMatch(/you have (diabetes|anaemia|anemia|cancer|disease)/i);
  });

  it('HTML shows draft status, escapes content and includes provenance', () => {
    const evil = buildReport({ snapshotId: 's<script>', snapshotHash: 'h', ruleRunId: 'r', ruleRunOutputHash: 'o', rules, observations: [{ ...obs[0], analyte: '<img src=x onerror=alert(1)>' }], documentLabel: 'd', createdAt: 'now' });
    const html = renderReportHtml(evil, { reportId: 'rep1', version: 1, status: 'draft' });
    expect(html).toContain('DRAFT — not reviewed');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('sha256');
  });
});
