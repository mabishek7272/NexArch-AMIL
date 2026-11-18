/**
 * Model-backed adapters (plan §6): Gemini vision OCR, Gemini embeddings, and
 * Decision 1 → Gemma review over VERIFIED stored execution records.
 * All use the role client in ./openrouter.ts (bounded, no silent substitution).
 */
import { OcrEngine, OcrResult, OcrLine } from '../documents/ocr';
import { modelRoles, modelCall, ProbeRecord, publicRecord, DataClass, configuredEmbeddingDims, SpendScope } from './openrouter';

// ── Vision OCR ────────────────────────────────────────────────────────────────

/**
 * Page images cannot be de-identified by text rules. Images are sent only when
 * raw egress is permitted (provider declared BAA-covered) or when the caller
 * explicitly marks the input as synthetic test data (tests/probes only — no
 * route sets this flag).
 */
export function geminiVisionOcrEngine(opts: { syntheticTestData?: boolean; model?: string; scope?: SpendScope } = {}): OcrEngine {
  const model = opts.model ?? modelRoles().ocr;
  const name = `openrouter:${model}`;
  return {
    name,
    async recognize(png: Buffer): Promise<OcrResult> {
      // The guarded transport blocks patient-derived images unless raw egress is permitted.
      const rec = await modelCall({ role: 'ocr', model, path: '/chat/completions', dataClass: opts.syntheticTestData ? 'synthetic_test' : 'patient_derived', scope: opts.scope, body: {
        model,
        reasoning: { effort: 'medium' },
        response_format: { type: 'json_object' },
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe the text of this document page exactly, line by line, preserving numbers, units, decimal points and inequality signs. Do not interpret, correct or add anything. Mark unreadable text as [illegible]. Return JSON {"lines":[{"text":string,"legible":boolean}]} only.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
          ],
        }],
      } });
      if (rec.status === 'blocked_by_egress_policy') return { status: 'blocked_by_egress_policy', error: 'image_egress_not_permitted', lines: [], meanConfidence: null, engine: name };
      if (rec.status !== 'ok') return { status: rec.status === 'timeout' || rec.status === 'unavailable' ? 'unavailable' : 'failed', error: `model_${rec.status}`, lines: [], meanConfidence: null, engine: name };
      const parsed = parseJsonContent(rec.data);
      if (!parsed || !Array.isArray(parsed.lines) || !parsed.lines.every((l: any) => typeof l?.text === 'string')) {
        return { status: 'failed', error: 'model_malformed_output', lines: [], meanConfidence: null, engine: name };
      }
      // The model reports no calibrated confidence: keep null so every line is
      // flagged for human confirmation downstream.
      const lines: OcrLine[] = parsed.lines.map((l: any) => ({ text: l.text, confidence: null }));
      return { status: 'ok', lines, meanConfidence: null, engine: `${name}@${rec.returnedModel ?? model}` };
    },
  };
}

export function parseJsonContent(data: any): any | null {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { return null; }
}

// ── Embeddings ────────────────────────────────────────────────────────────────

export interface EmbeddingResult { status: ProbeRecord['status']; vectors: number[][]; dims: number | null; model: string; returnedModel?: string; identity?: ProbeRecord['identity']; error?: string }

/**
 * Strict embedding response validation: exactly n rows, unique contiguous integer
 * indices 0..n-1, non-empty finite vectors, all of the configured dimension.
 */
export function validateEmbeddingRows(rows: unknown, n: number, dims: number): { ok: true; vectors: number[][] } | { ok: false; error: string } {
  if (!Array.isArray(rows) || rows.length !== n) return { ok: false, error: `expected ${n} embedding rows` };
  const byIndex = new Map<number, number[]>();
  for (const r of rows as any[]) {
    const idx = r?.index;
    if (!Number.isInteger(idx) || idx < 0 || idx >= n) return { ok: false, error: 'embedding index missing or out of range' };
    if (byIndex.has(idx)) return { ok: false, error: 'duplicate embedding index' };
    const v = r?.embedding;
    if (!Array.isArray(v) || v.length === 0) return { ok: false, error: 'empty embedding vector' };
    if (!v.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))) return { ok: false, error: 'non-finite embedding value' };
    if (v.length !== dims) return { ok: false, error: `embedding has ${v.length} dimensions, configured ${dims}` };
    byIndex.set(idx, v);
  }
  return { ok: true, vectors: Array.from({ length: n }, (_, i) => byIndex.get(i)!) };
}

export async function embedTexts(texts: string[], opts: { model?: string; dataClass?: DataClass; dims?: number; scope?: SpendScope } = {}): Promise<EmbeddingResult> {
  const model = opts.model ?? modelRoles().embedding;
  const dims = opts.dims ?? configuredEmbeddingDims();
  if (!texts.length) return { status: 'ok', vectors: [], dims, model };
  const rec = await modelCall({ role: 'embedding', model, path: '/embeddings', dataClass: opts.dataClass ?? 'patient_derived', scope: opts.scope, body: { input: texts } });
  if (rec.status !== 'ok') return { status: rec.status, vectors: [], dims: null, model, error: rec.detail ?? rec.status };
  const v = validateEmbeddingRows(rec.data?.data, texts.length, dims);
  if (!v.ok) return { status: 'malformed', vectors: [], dims: null, model, error: v.error };
  return { status: 'ok', vectors: v.vectors, dims, model, returnedModel: rec.returnedModel, identity: rec.identity };
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('dimension mismatch');
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export { publicRecord };
