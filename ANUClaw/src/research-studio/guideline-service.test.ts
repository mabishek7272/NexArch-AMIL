/** Pure unit tests for buildComplianceReport — no DB, no I/O. A compliance report is explicitly NOT a journal
 * acceptance or a checklist certification; it only restates recorded word counts and recorded human confirmations. */
import { describe, expect, it } from 'vitest';
import { buildComplianceReport, ChecklistItem } from './guideline-service';
import { GuidelineRow } from './types';

const guideline = (constraints: unknown, checklist: ChecklistItem[]): GuidelineRow => ({
  id: 'g1', project_id: 'p1', version: 1, journal_or_university: 'Journal of Examples',
  constraints_json: JSON.stringify(constraints), checklist_json: JSON.stringify(checklist), created_by: 'u1', created_at: 0,
});

describe('buildComplianceReport', () => {
  it('states explicitly that it is not a journal acceptance or a checklist certification', () => {
    const r = buildComplianceReport([], undefined);
    expect(r.notice).toMatch(/NOT a journal acceptance/); expect(r.notice).toMatch(/NOT a certification/);
  });
  it('computes real word counts per section against recorded limits', () => {
    const sections = [{ section_key: 'intro', content_text: 'one two three four five' }, { section_key: 'methods', content_text: 'one two' }];
    const r = buildComplianceReport(sections, guideline({ sectionWordLimits: { intro: 4, methods: 10 } }, []));
    expect(r.wordCounts).toEqual([
      { sectionKey: 'intro', words: 5, limit: 4, withinLimit: false },
      { sectionKey: 'methods', words: 2, limit: 10, withinLimit: true },
    ]);
  });
  it('a section with no recorded limit gets withinLimit: null — never silently "true"', () => {
    const r = buildComplianceReport([{ section_key: 'x', content_text: 'a b c' }], guideline({}, []));
    expect(r.wordCounts[0]).toMatchObject({ limit: null, withinLimit: null });
  });
  it('a checklist item counts as satisfied ONLY when explicitly confirmed=true — never auto-ticked', () => {
    const checklist: ChecklistItem[] = [
      { id: 'c1', label: 'Item 1', confirmed: true, confirmedBy: 'u1', confirmedAt: 100 },
      { id: 'c2', label: 'Item 2', confirmed: false, confirmedBy: null, confirmedAt: null },
    ];
    const r = buildComplianceReport([], guideline({}, checklist));
    expect(r.checklist.map((c) => c.status)).toEqual(['confirmed', 'not_confirmed']);
    expect(r.checklistFullyConfirmed).toBe(false);
  });
  it('checklistFullyConfirmed is true only when every item is confirmed, and false (never vacuously true) with an empty checklist', () => {
    const allConfirmed: ChecklistItem[] = [{ id: 'c1', label: 'x', confirmed: true, confirmedBy: 'u', confirmedAt: 1 }];
    expect(buildComplianceReport([], guideline({}, allConfirmed)).checklistFullyConfirmed).toBe(true);
    expect(buildComplianceReport([], guideline({}, [])).checklistFullyConfirmed).toBe(false);
  });
  it('with no guideline at all, every limit/checklist field is empty/null, never assumed', () => {
    const r = buildComplianceReport([{ section_key: 'x', content_text: 'a b' }], undefined);
    expect(r.journalOrUniversity).toBeNull(); expect(r.wordCounts[0].limit).toBeNull(); expect(r.checklist).toEqual([]);
  });
});
