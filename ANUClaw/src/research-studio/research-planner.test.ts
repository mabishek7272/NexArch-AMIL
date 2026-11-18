/** Pure unit tests (no database): brief validation (plan §1) and the deterministic Research Planner (plan §3). */
import { describe, expect, it } from 'vitest';
import { validateBrief } from './project-service';
import { planFor } from './agents/research-planner';
import { ResearchBrief } from './types';

const base: ResearchBrief = { topic: 'Topic', question: 'Question?' };

describe('validateBrief (plan §1 — never invent a study to fill missing inputs)', () => {
  it('requires topic and question for every mode', () => {
    expect(validateBrief('narrative_review', {} as ResearchBrief).join(';')).toMatch(/topic is required/);
    expect(validateBrief('narrative_review', { topic: 'x' } as ResearchBrief).join(';')).toMatch(/question is required/);
  });
  it('review modes require a real search method (narrative) or search+screening method (systematic/scoping)', () => {
    expect(validateBrief('narrative_review', base)).toEqual(['narrative_review requires searchMethod (the ACTUAL search method to be used — never invented after the fact)']);
    expect(validateBrief('narrative_review', { ...base, searchMethod: 'manual PubMed search' })).toEqual([]);
    const sys = validateBrief('systematic_review', base);
    expect(sys).toContain('systematic_review requires searchMethod (the ACTUAL search method to be used — never invented after the fact)');
    expect(sys).toContain('systematic_review requires screeningMethod');
    expect(sys.some((p) => /traceable protocol/.test(p))).toBe(true);
  });
  it('a "systematic review" label is refused without a traceable search strategy (databases + queries)', () => {
    const withMethods: ResearchBrief = { ...base, searchMethod: 'm', screeningMethod: 's' };
    expect(validateBrief('systematic_review', withMethods).some((p) => /traceable protocol/.test(p))).toBe(true);
    expect(validateBrief('systematic_review', { ...withMethods, searchStrategy: { databases: [], queries: ['x'] } }).length).toBeGreaterThan(0);
    expect(validateBrief('systematic_review', { ...withMethods, searchStrategy: { databases: ['PubMed'], queries: ['x'] } })).toEqual([]);
  });
  it('original_research requires hasData to be stated explicitly (true or false) before creation', () => {
    expect(validateBrief('original_research', base).join(';')).toMatch(/requires hasData/);
    expect(validateBrief('original_research', { ...base, hasData: false })).toEqual([]);      // false is an honest, allowed answer — just not fabricated
    expect(validateBrief('original_research', { ...base, hasData: true })).toEqual([]);
  });
  it('case_report requires an authorised, substantive data-permissions attestation', () => {
    expect(validateBrief('case_report', base).join(';')).toMatch(/dataPermissions/);
    expect(validateBrief('case_report', { ...base, dataPermissions: { authorized: false, statement: 'a reasonably long statement' } }).length).toBeGreaterThan(0);
    expect(validateBrief('case_report', { ...base, dataPermissions: { authorized: true, statement: 'short' } }).length).toBeGreaterThan(0);
    expect(validateBrief('case_report', { ...base, dataPermissions: { authorized: true, statement: 'a reasonably long statement' } })).toEqual([]);
  });
  it('dissertation requires an institution and at least one chapter outline entry', () => {
    const p = validateBrief('dissertation', base); expect(p).toContain('dissertation requires institution'); expect(p).toContain('dissertation requires at least one chapterOutline entry');
    expect(validateBrief('dissertation', { ...base, institution: 'A University', chapterOutline: ['Introduction'] })).toEqual([]);
  });
  it('research_protocol and a well-formed original_research brief need nothing beyond topic/question/hasData', () => {
    expect(validateBrief('research_protocol', base)).toEqual([]);
    expect(validateBrief('original_research', { ...base, hasData: true, dataResearchRunId: 'r1' })).toEqual([]);
  });
});

describe('planFor (Research Planner, plan §3 — deterministic, zero-cost, no fabrication)', () => {
  it('is pure: identical inputs always produce an identical plan', () => {
    const brief: ResearchBrief = { ...base, searchMethod: 'm', referenceTarget: 40, inclusionCriteria: 'a', exclusionCriteria: 'b' };
    expect(planFor('narrative_review', brief)).toEqual(planFor('narrative_review', brief));
  });
  it('review modes get a literature → evidence pipeline (M2: search → verify → extract → matrix → synthesize) that original_research and research_protocol do not', () => {
    const review = planFor('narrative_review', { ...base, searchMethod: 'm', referenceTarget: 10, inclusionCriteria: 'a', exclusionCriteria: 'b' });
    const types = review.tasks.map((t) => t.type);
    expect(types).toEqual(expect.arrayContaining(['literature.search_strategy', 'literature.search_execute', 'literature.verify_sources', 'evidence.extract', 'evidence.build_matrix', 'evidence.synthesize']));
    expect(types.indexOf('literature.search_execute')).toBeLessThan(types.indexOf('literature.verify_sources'));
    expect(types.indexOf('literature.verify_sources')).toBeLessThan(types.indexOf('evidence.extract'));
    expect(types.indexOf('evidence.extract')).toBeLessThan(types.indexOf('evidence.build_matrix'));
    expect(types.indexOf('evidence.build_matrix')).toBeLessThan(types.indexOf('evidence.synthesize'));
    const orig = planFor('original_research', { ...base, hasData: true, dataResearchRunId: 'r1' });
    expect(orig.tasks.map((t) => t.type)).not.toContain('literature.search_strategy');
    expect(orig.tasks.map((t) => t.type)).toContain('methods.analysis');
  });
  it('original_research WITHOUT confirmed data withholds writing.draft_sections (and the citation audit that would follow it) and records why — never fabricating results', () => {
    const noData = planFor('original_research', { ...base, hasData: false });
    expect(noData.tasks.map((t) => t.type)).not.toContain('writing.draft_sections');
    expect(noData.tasks.map((t) => t.type)).not.toContain('citation.audit');
    expect(noData.unresolvedDecisions.some((d) => /withheld/.test(d))).toBe(true);
    expect(noData.missingInputs.some((m) => /actual data\/results/.test(m))).toBe(true);
    const withData = planFor('original_research', { ...base, hasData: true, dataResearchRunId: 'r1' });
    expect(withData.tasks.map((t) => t.type)).toContain('writing.draft_sections');
  });
  it('every graph ends in citation.audit → critique → export, and dependencies form a DAG resolvable by task type', () => {
    const p = planFor('research_protocol', base); const types = p.tasks.map((t) => t.type);
    expect(types[types.length - 3]).toBe('citation.audit'); expect(types[types.length - 2]).toBe('critique.review'); expect(types[types.length - 1]).toBe('export.manuscript');
    const seen = new Set<string>();
    for (const t of p.tasks) { for (const d of t.dependsOn) expect(seen.has(d), `"${d}" must be created before "${t.type}" depends on it`).toBe(true); seen.add(t.type); }
  });
  it('the writing task heads a BOUNDED revision group sized maxRevisionRounds+1 (plan §4)', () => {
    const p = planFor('research_protocol', { ...base, maxRevisionRounds: 3 });
    const writing = p.tasks.find((t) => t.type === 'writing.draft_sections');
    expect(writing?.revisionGroup).toBeTruthy(); expect(writing?.maxRevisionsInGroup).toBe(4);
  });
  it('dissertation drafts CHAPTERS (writing.draft_chapters), not sections', () => {
    const p = planFor('dissertation', { ...base, institution: 'A University', chapterOutline: ['Intro'] });
    const types = p.tasks.map((t) => t.type);
    expect(types).toContain('writing.draft_chapters'); expect(types).not.toContain('writing.draft_sections');
    expect(types).toContain('citation.audit'); // every content-producing mode gets audited the same way
  });
  it('flags unresolved decisions for missing bounds instead of silently assuming a default', () => {
    const p = planFor('research_protocol', base);
    expect(p.unresolvedDecisions.some((d) => /word or page limit/.test(d))).toBe(true);
    expect(p.unresolvedDecisions.some((d) => /maxRevisionRounds/.test(d))).toBe(true);
    const bounded = planFor('research_protocol', { ...base, wordLimits: { overall: 3000 }, maxRevisionRounds: 1 });
    expect(bounded.unresolvedDecisions.some((d) => /word or page limit/.test(d))).toBe(false);
    expect(bounded.stoppingConditions[0]).toMatch(/At most 1 critic\/revision round/);
  });
});
