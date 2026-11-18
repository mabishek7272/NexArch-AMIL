import { readRecords, UseChecker } from '../reader';
export * from './common'; export * from './loaders'; export * from './baselines'; export * from './pathology';
/** Protocols Q&A is rubric-graded: this only loads and validates its structure (rubric counts); there is no offline scorer and no model judge is called. */
export async function protocolsQnaSummary(o: { root?: string; checker?: UseChecker } = {}): Promise<{ rows: number; withRubrics: number; restrictedColumns: string[]; scorable: false; note: string }> {
  const rows = await readRecords('clinical_eval/indian_protocols_clinical_qna.csv', 'local_evaluation', { root: o.root, checker: o.checker });
  const ok = rows.filter((r) => { try { return Array.isArray(JSON.parse(String(r.answer_rubrics))); } catch { return false; } }).length;
  return { rows: rows.length, withRubrics: ok, restrictedColumns: ['patient_case', 'doctor_query', 'doctor_persona', 'scenario'], scorable: false, note: 'Rubric-graded; scoring needs a judge (human or model). No judge is called here and nothing is scored.' };
}
