/**
 * Guarded model transport: identity rules, error sanitisation, hook/egress
 * boundary, strict embedding validation and review validators. Provider HTTP is
 * mocked (live checks are in scripts/probe-models.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const llm = vi.hoisted(() => ({ provider: 'openrouter', openrouterApiKey: 'sk-or-test-not-real-000000000', openrouterBaseUrl: 'https://provider.invalid/api/v1', openrouterReasoningEffort: 'medium' } as any));
vi.mock('../config', () => ({ config: { llm } }));
vi.mock('../logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('axios', () => ({ default: { post: vi.fn() } }));

import axios from 'axios';
import { checkModelIdentity, modelCall } from './openrouter';
import { validateEmbeddingRows, embedTexts, geminiVisionOcrEngine } from './adapters';
import { validateChecks, validateReviewShape, fidelityProblems, hasBlock } from './engine-review-service';
import { registerHook, unregisterHook } from '../hooks';

const post = vi.mocked(axios.post);
const ok = (data: any, status = 200) => ({ status, data });
const sent = () => post.mock.calls.at(-1)?.[1] as any;

beforeEach(() => { post.mockReset(); delete process.env.LLM_BAA_COVERED; delete process.env.ELAB_DEID_REQUIRED; });
afterEach(() => { for (const h of ['t-block', 't-mod', 't-after']) unregisterHook(h); });

describe('model identity', () => {
  it.each([
    ['google/gemini-3.8-flash', 'google/gemini-3.8-flash', 'exact'],
    ['google/gemini-embedding-2', 'gemini-embedding-2', 'documented_alias'],
    ['google/gemini-decision-1', 'google/gemini-decision-1-20261111', 'verified_dated_version'],
    ['google/gemini-decision-1', 'google/gemini-decision-1-20991231', 'mismatch'],   // unverified date
    ['google/gemini-3.8-flash', 'google/gemini-3.8-flash-other', 'mismatch'],
    ['google/gemini-3.8-flash', 'google/gemini-3.8-flash:free', 'mismatch'],
    ['google/gemini-embedding-2', 'gemini-embedding-001', 'mismatch'],
    ['google/gemma-4-26b-a4b-it', undefined, 'unverified_missing'],
    ['google/gemma-4-26b-a4b-it', '', 'unverified_missing'],
  ])('%s ← %s = %s', (req, ret, expected) => {
    expect(checkModelIdentity(req, ret as any)).toBe(expected);
  });

  it('a mismatched model result is discarded; a missing id is recorded as unverified', async () => {
    post.mockResolvedValueOnce(ok({ model: 'google/gemma-4-26b-a4b-it-other', choices: [{ message: { content: 'x' } }] }));
    const a = await modelCall({ role: 'review', path: '/chat/completions', dataClass: 'synthetic_test', body: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(a.status).toBe('model_mismatch');
    expect(a.data).toBeUndefined();
    post.mockResolvedValueOnce(ok({ choices: [{ message: { content: 'x' } }] }));
    const b = await modelCall({ role: 'review', path: '/chat/completions', dataClass: 'synthetic_test', body: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(b).toMatchObject({ status: 'ok', identity: 'unverified_missing' });
  });
});

describe('provider errors are sanitised', () => {
  it('error messages that echo input are never returned', async () => {
    post.mockResolvedValue(ok({ error: { code: 'invalid_request', message: 'Bad request near "patient name: Jane Synthetic"' } }, 400));
    const r = await modelCall({ role: 'review', path: '/chat/completions', dataClass: 'synthetic_test', body: { messages: [{ role: 'user', content: 'x' }] } });
    expect(r).toMatchObject({ status: 'http_error', httpStatus: 400, providerErrorCode: 'invalid_request' });
    expect(JSON.stringify(r)).not.toContain('Jane');
  });

  it('non-code error codes are dropped; network exceptions keep only a code', async () => {
    post.mockResolvedValueOnce(ok({ error: { code: 'contains spaces and "quotes" Jane' } }, 400));
    const r = await modelCall({ role: 'review', path: '/chat/completions', dataClass: 'synthetic_test', body: { messages: [] }, retries: 0 });
    expect(r.providerErrorCode).toBeUndefined();
    post.mockRejectedValueOnce(Object.assign(new Error('connect failed for prompt "Jane Synthetic"'), { code: 'ECONNREFUSED' }));
    const n = await modelCall({ role: 'review', path: '/chat/completions', dataClass: 'synthetic_test', body: { messages: [] }, retries: 0 });
    expect(n).toMatchObject({ status: 'http_error', detail: 'ECONNREFUSED' });
    expect(JSON.stringify(n)).not.toContain('Jane');
  });
});

describe('every call passes the hook + egress boundary', () => {
  const PATIENT = 'Summarise: patient name: Jane Synthetic, MRN: SYN12345.';

  it('BeforeLLMCall block → no provider call', async () => {
    registerHook('t-block', 'BeforeLLMCall', () => ({ outcome: 'block' }), 1);
    const r = await modelCall({ role: 'review', path: '/chat/completions', dataClass: 'patient_derived', body: { messages: [{ role: 'user', content: PATIENT }] } });
    expect(r.status).toBe('blocked_by_policy');
    expect(post).not.toHaveBeenCalled();
  });

  it('a hook cannot substitute the model', async () => {
    registerHook('t-mod', 'BeforeLLMCall', (ctx) => ({ outcome: 'modify', payload: { ...ctx.payload, body: { ...(ctx.payload.body as object), model: 'other/model' } } }), 1);
    post.mockResolvedValue(ok({ model: 'google/gemma-4-26b-a4b-it', choices: [{ message: { content: 'x' } }] }));
    await modelCall({ role: 'review', path: '/chat/completions', dataClass: 'synthetic_test', body: { messages: [{ role: 'user', content: 'x' }] } });
    expect(sent().model).toBe('google/gemma-4-26b-a4b-it');
  });

  it('patient-derived text is de-identified before egress and re-identified after', async () => {
    post.mockResolvedValue(ok({ model: 'google/gemma-4-26b-a4b-it', choices: [{ message: { content: 'For [NAME_1] ([MRN_1])' } }] }));
    const r = await modelCall({ role: 'review', path: '/chat/completions', dataClass: 'patient_derived', body: { messages: [{ role: 'user', content: PATIENT }] } });
    expect(JSON.stringify(sent())).not.toContain('Jane Synthetic');
    expect(JSON.stringify(sent())).not.toContain('SYN12345');
    expect(r.data.choices[0].message.content).toBe('For Jane Synthetic (SYN12345)');
    expect(r.egress).toMatchObject({ mode: 'deidentified' });
  });

  it('decision state and embedding inputs are de-identified too', async () => {
    post.mockResolvedValue(ok({ model: 'google/gemini-decision-1', answers: {} }));
    await modelCall({ role: 'decision', path: '../alpha/decisions', dataClass: 'patient_derived', body: { state: [PATIENT], questions: {} } });
    expect(JSON.stringify(sent())).not.toContain('SYN12345');
    post.mockResolvedValue(ok({ model: 'google/gemini-embedding-2', data: [{ index: 0, embedding: Array(3072).fill(0.1) }] }));
    await embedTexts([PATIENT]);
    expect(JSON.stringify(sent())).not.toContain('SYN12345');
  });

  it('patient-derived images are blocked unless raw egress is permitted', async () => {
    const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] };
    expect((await modelCall({ role: 'ocr', path: '/chat/completions', dataClass: 'patient_derived', body: JSON.parse(JSON.stringify(body)) })).status).toBe('blocked_by_egress_policy');
    expect(post).not.toHaveBeenCalled();
    const ocr = await geminiVisionOcrEngine().recognize(Buffer.from('png'), 'p.png');
    expect(ocr.status).toBe('blocked_by_egress_policy');
    process.env.LLM_BAA_COVERED = 'true';
    post.mockResolvedValue(ok({ model: 'google/gemini-3.8-flash', choices: [{ message: { content: '{"lines":[{"text":"A 1"}]}' } }] }));
    expect((await modelCall({ role: 'ocr', path: '/chat/completions', dataClass: 'patient_derived', body: JSON.parse(JSON.stringify(body)) })).status).toBe('ok');
  });

  it('AfterToolCall block withholds the output', async () => {
    registerHook('t-after', 'AfterToolCall', () => ({ outcome: 'block' }), 1);
    post.mockResolvedValue(ok({ model: 'google/gemma-4-26b-a4b-it', choices: [{ message: { content: 'x' } }] }));
    const r = await modelCall({ role: 'review', path: '/chat/completions', dataClass: 'synthetic_test', body: { messages: [] } });
    expect(r.status).toBe('output_blocked_by_policy');
    expect((r as any).data).toBeUndefined();
  });

  it('vision OCR: malformed model output is a failure; lines carry null confidence', async () => {
    post.mockResolvedValueOnce(ok({ model: 'google/gemini-3.8-flash', choices: [{ message: { content: 'not json' } }] }));
    expect((await geminiVisionOcrEngine({ syntheticTestData: true }).recognize(Buffer.from('png'), 'p.png')).error).toBe('model_malformed_output');
    post.mockResolvedValueOnce(ok({ model: 'google/gemini-3.8-flash', choices: [{ message: { content: '```json\n{"lines":[{"text":"Na 140"}]}\n```' } }] }));
    const r = await geminiVisionOcrEngine({ syntheticTestData: true }).recognize(Buffer.from('png'), 'p.png');
    expect(r).toMatchObject({ status: 'ok', meanConfidence: null, lines: [{ text: 'Na 140', confidence: null }] });
  });
});

describe('strict embedding validation', () => {
  const v = (n = 4, x = 0.5) => Array(n).fill(x);
  it.each([
    ['wrong row count', [{ index: 0, embedding: v() }], 2],
    ['missing index', [{ embedding: v() }, { index: 1, embedding: v() }], 2],
    ['duplicate index', [{ index: 0, embedding: v() }, { index: 0, embedding: v() }], 2],
    ['out-of-range index', [{ index: 0, embedding: v() }, { index: 2, embedding: v() }], 2],
    ['non-integer index', [{ index: 0.5, embedding: v() }], 1],
    ['empty vector', [{ index: 0, embedding: [] }], 1],
    ['NaN', [{ index: 0, embedding: [0.1, NaN, 0.1, 0.1] }], 1],
    ['Infinity', [{ index: 0, embedding: [0.1, Infinity, 0.1, 0.1] }], 1],
    ['non-number', [{ index: 0, embedding: [0.1, '0.2', 0.1, 0.1] }], 1],
    ['dimension mismatch', [{ index: 0, embedding: v(3) }], 1],
    ['not an array', null, 1],
  ])('rejects %s', (_l, rows, n) => {
    expect(validateEmbeddingRows(rows, n as number, 4).ok).toBe(false);
  });

  it('accepts valid rows and orders by index', () => {
    const r = validateEmbeddingRows([{ index: 1, embedding: v(4, 2) }, { index: 0, embedding: v(4, 1) }], 2, 4);
    expect(r.ok && r.vectors.map((x) => x[0])).toEqual([1, 2]);
  });

  it('embedTexts enforces the configured dimension', async () => {
    post.mockResolvedValue(ok({ model: 'gemini-embedding-2', data: [{ index: 0, embedding: v(768) }] }));
    expect((await embedTexts(['synthetic'], { dataClass: 'synthetic_test' })).status).toBe('malformed');
  });
});

describe('review validators', () => {
  it('decision answers must be allowed choices with confidence in [0,1]', () => {
    expect(validateChecks({ engine_evidence: { choice: 'sufficient', confidence: 0.9 }, consistency: { choice: 'consistent', confidence: 0.8 } })).toBeNull();
    expect(validateChecks({ engine_evidence: { choice: 'approve', confidence: 0.9 }, consistency: { choice: 'consistent', confidence: 0.8 } })).toMatch(/invalid/);
    expect(validateChecks({ engine_evidence: { choice: 'sufficient', confidence: 2 }, consistency: { choice: 'consistent', confidence: 0.8 } })).toMatch(/invalid/);
    expect(validateChecks(null)).toBe('decision_no_answers');
  });

  it('numeric and citation fidelity', () => {
    const review = { summary: 'Hemoglobin 16.4 exceeds 15.5.', points: [{ text: 'F0 shows 99 mg', cites: [0] }, { text: 'uncited', cites: [] }, { text: 'bad cite', cites: [7] }], limitations: [], defers_to_block: false };
    expect(validateReviewShape(review)).toBe(true);
    const p = fidelityProblems(review, new Set(['16.4', '15.5', '0']), 1);
    expect(p).toEqual(expect.arrayContaining(['number 99 is not in the verified data', 'point 1 has no citation', 'point 2 cites finding 7, which does not exist']));
  });

  it('detects deterministic blocks anywhere in engine output', () => {
    expect(hasBlock({ findings: [{ nested: { decision: 'block' } }] })).toBe(true);
    expect(hasBlock({ findings: [{ result: 'within_reported_interval' }] })).toBe(false);
  });
});
