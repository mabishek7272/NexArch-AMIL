/**
 * Legacy helper kept for compatibility. New code should use
 * src/documents/ocr.ts (page-level, structured, explicit failure states).
 */
import * as fs from 'fs';
import { paddleServiceEngine } from './documents/ocr';

/** Returns recognised text, or null when OCR is unavailable/failed (never fabricated). */
export async function extractTextWithOcr(filePath: string): Promise<string | null> {
  const r = await paddleServiceEngine().recognize(fs.readFileSync(filePath), filePath.split('/').pop() ?? 'page.png');
  return r.status === 'ok' && r.lines.length ? r.lines.map((l) => l.text).join('\n') : null;
}
