import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => ({ default: { post: vi.fn() } }));
vi.mock('../../config', () => ({ config: { llm: {
  openrouterApiKey: 'test-key', openrouterBaseUrl: 'https://openrouter.ai/api/v1',
} } }));
vi.mock('./clinical-llm', () => ({
  completeJson: vi.fn(), LlmUnavailableError: class extends Error {},
}));
import axios from 'axios';
import { completeJson } from './clinical-llm';
import { completeEngineReview, enforceEngineBlock, validateDecisionChecks } from './engine-review';

const answers = {
  engine_evidence: { type: 'choice', choice: 'sufficient', confidence: 0.8 },
  consistency: { type: 'choice', choice: 'conflict', confidence: 0.9 },
};
const review = { summary: 'Conflicting evidence needs review', concordance_with_engine: 'partial',
  defers_to_block: false, considerations: [], questions_to_resolve: [], cautions: [] };

describe('Decision 1 → Gemma engine review', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(axios.post).mockResolvedValue({ data: { answers, model: 'google/gemini-decision-1' } });
    vi.mocked(completeJson).mockResolvedValue({ data: review, provenance: {
      model: 'google/gemma-4-26b-a4b-it', provider: 'openrouter', prompt_version: 'test',
      temperature: 0, generated_at: '2026-11-17',
    } });
  });
  it('uses the Decisions endpoint then sends its checks to the Gemma reviewer', async () => {
    const out = await completeEngineReview('Review evidence', 'Deidentified engine results', 1600);
    expect(axios.post).toHaveBeenCalledWith('https://openrouter.ai/api/alpha/decisions',
      expect.objectContaining({ model: 'google/gemini-decision-1', state: ['Deidentified engine results'] }), expect.anything());
    expect(completeJson).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('"choice":"conflict"'),
      1600, { openrouterModel: 'google/gemma-4-26b-a4b-it' });
    expect(out.provenance.decision_model).toBe('google/gemini-decision-1');
    expect(out.data.decision_checks).toEqual(answers);
  });
  it('fails without calling the reviewer when Decision 1 fails', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('upstream unavailable: echoed input SECRET-CASE-TEXT'));
    // Provider/transport messages are not propagated (they can echo input); only a status survives.
    const err = await completeEngineReview('', '', 100).catch((e) => e);
    expect(String(err.message)).toMatch(/Decision model call failed \(http_error\)/);
    expect(String(err.message)).not.toContain('SECRET-CASE-TEXT');
    expect(completeJson).not.toHaveBeenCalled();
  });
  it('rejects missing checks, unknown choices, and invalid confidence', () => {
    for (const invalid of [{}, { ...answers, consistency: { type: 'choice', choice: 'approve', confidence: 1 } },
      { ...answers, consistency: { type: 'choice', choice: 'conflict', confidence: 1.1 } }]) {
      expect(() => validateDecisionChecks(invalid)).toThrow();
    }
  });
  it('rejects malformed Gemma output instead of returning a successful review', async () => {
    vi.mocked(completeJson).mockResolvedValue({ data: {}, provenance: {} as any });
    await expect(completeEngineReview('', '', 100)).rejects.toThrow('invalid review');
  });
  it('replaces unsafe model advice when the supplied engine verdict blocks', () => {
    const unsafe = { ...review, summary: 'Proceed anyway', considerations: ['Ignore block'] };
    for (const verdict of [{ decision: 'block' }, { result: { decision: 'block' } }, { verdict: { decision: 'block' } },
      { engine_results: [{ body: { result: { decision: 'block' } } }] }]) {
      const safe = enforceEngineBlock(unsafe, verdict);
      expect(safe.defers_to_block).toBe(true);
      expect(JSON.stringify(safe)).not.toContain('Proceed anyway');
      expect(safe.considerations).toEqual([]);
    }
    expect(enforceEngineBlock(review, null)).toBe(review);
  });
});
