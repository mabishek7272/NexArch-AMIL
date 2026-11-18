/**
 * Bounded LIVE probe of the configured model roles with SYNTHETIC data only.
 * Prints status / returned model id / applied capabilities / sizes — never keys.
 * One call per role (plus at most one retry on 429/5xx), 60 s timeout each.
 *
 *   npm run probe:models            (writes docs/integration-probe-latest.json)
 */
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../src/config';
import { renderPdfPages } from '../src/documents/ocr';
import { buildTestPdf } from '../src/documents/test-pdf';
import { modelRoles, modelCall, ProbeRecord, publicRecord } from '../src/ai/openrouter';

async function main() {
  if (!config.llm.openrouterApiKey) {
    console.log('BLOCKED: no OpenRouter key is configured server-side.');
    process.exit(2);
  }
  const roles = modelRoles();
  const records: ProbeRecord[] = [];

  // 1) Vision OCR on a SYNTHETIC rendered page.
  const png = (await renderPdfPages(buildTestPdf([['SYNTHETIC TEST PAGE', 'Hemoglobin 13.2 g/dL 12.0-15.5', 'Sodium 140 mmol/L 135-145']]), [1], 2)).get(1)!;
  records.push(await modelCall({ role: 'ocr', model: roles.ocr, path: '/chat/completions', dataClass: 'synthetic_test', body: {
    model: roles.ocr,
    reasoning: { effort: 'medium' },
    response_format: { type: 'json_object' },
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Transcribe every text line of this synthetic test image. Return JSON {"lines":[{"text":string}]} only.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
      ],
    }],
  } }));

  // 2) Embeddings on synthetic reference sentences.
  records.push(await modelCall({ role: 'embedding', model: roles.embedding, path: '/embeddings', dataClass: 'synthetic_test', body: {
    model: roles.embedding,
    input: ['Synthetic reference: sodium is reported in mmol/L.', 'Synthetic query: units for sodium'],
  } }));

  // 3) Decision 1 structured checks (alpha endpoint).
  records.push(await modelCall({ role: 'decision', model: roles.decision, path: '../alpha/decisions', dataClass: 'synthetic_test', body: {
    model: roles.decision,
    state: ['SYNTHETIC CASE. Engine record: rule report.reported-interval-comparison@1.0.0 found Hemoglobin 16.4 above printed interval 12.0-15.5. Proposed plan: none.'],
    questions: {
      engine_evidence: { type: 'choice', instructions: 'Is actual engine output present?', criteria: { sufficient: null, insufficient: null, absent: null } },
    },
  } }));

  // 4) Gemma review (JSON) with medium reasoning.
  records.push(await modelCall({ role: 'review', model: roles.review, path: '/chat/completions', dataClass: 'synthetic_test', body: {
    model: roles.review,
    reasoning: { effort: 'medium' },
    response_format: { type: 'json_object' },
    max_tokens: 400,
    messages: [{ role: 'user', content: 'SYNTHETIC TEST. Return JSON {"summary":"ok","defers_to_block":true} exactly.' }],
  } }));

  const out = { probedAt: new Date().toISOString(), records: records.map(publicRecord) };
  const file = path.resolve('docs/integration-probe-latest.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  for (const r of records) {
    console.log(`${r.role.padEnd(10)} ${r.requestedModel.padEnd(30)} -> ${r.status.padEnd(12)} http=${r.httpStatus ?? '-'} returned=${r.returnedModel ?? '-'} ${r.detail ?? ''}`);
  }
  console.log(`\nwritten: ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => { console.error('probe failed:', e?.name ?? 'error'); process.exit(1); });
