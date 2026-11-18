/**
 * Static, EVIDENCE-FREE description of the AIKosh files found on disk: where each probably comes from and what it is probably for, inferred ONLY from file and column names.
 * Nothing here is provenance: the licence, consent, de-identification and external-processing status of every file is "unknown — blocked from external processing"
 * until a human records evidence in the registry.
 */
export interface CatalogEntry { domain: string; likelyPurpose: string; benchmark: string | null; twinOf?: string; note?: string }
export const CATALOG: Record<string, CatalogEntry> = {
  'clinical_eval/medical_calculator_eval.csv': { domain: 'clinical calculators', likelyPurpose: 'evaluation of numeric clinical-calculator answers (expected_output, tolerance)', benchmark: 'calculator' },
  'clinical_eval/medical_calculator_eval.parquet': { domain: 'clinical calculators', likelyPurpose: 'columnar copy of medical_calculator_eval.csv', benchmark: null, twinOf: 'clinical_eval/medical_calculator_eval.csv', note: 'equivalence to the CSV is not verified byte-for-byte; only row counts and schema are compared' },
  'clinical_eval/medmcqa_indic_en.csv': { domain: 'medical exam multiple-choice', likelyPurpose: 'MedMCQA-style multiple-choice evaluation (English subset)', benchmark: 'medmcqa' },
  'clinical_eval/medmcqa_indic_en.parquet': { domain: 'medical exam multiple-choice', likelyPurpose: 'columnar copy of medmcqa_indic_en.csv', benchmark: null, twinOf: 'clinical_eval/medmcqa_indic_en.csv' },
  'clinical_eval/indian_protocols_clinical_qna.csv': { domain: 'clinical protocols Q&A', likelyPurpose: 'rubric-graded clinical question answering over protocol documents (patient_case present)', benchmark: 'protocols_qna', note: 'contains patient_case narratives; rubric-graded, so not auto-scorable offline' },
  'clinical_eval/indian_protocols_clinical_qna.parquet': { domain: 'clinical protocols Q&A', likelyPurpose: 'columnar copy of indian_protocols_clinical_qna.csv', benchmark: null, twinOf: 'clinical_eval/indian_protocols_clinical_qna.csv' },
  'knowledge_graph/bodhi_s_triples.jsonl': { domain: 'symptom-condition knowledge graph', likelyPurpose: 'graph edges (head, relation, tail, likelihood properties)', benchmark: null },
  'knowledge_graph/bodhi_s_nl_facts.jsonl': { domain: 'symptom-condition knowledge graph', likelyPurpose: 'natural-language renderings of graph facts', benchmark: 'kg_retrieval' },
  'knowledge_graph/bodhi_m_triples.jsonl': { domain: 'concept hierarchy knowledge graph', likelyPurpose: 'CHILD_OF edges between concept ids', benchmark: null },
  'knowledge_graph/bodhi_m_nl_facts.jsonl': { domain: 'concept hierarchy knowledge graph', likelyPurpose: 'natural-language renderings of hierarchy facts', benchmark: 'kg_retrieval' },
  'lab/nidaankosha_lab_readings_sample.csv': { domain: 'laboratory results', likelyPurpose: 'lab test name/unit/value/LOINC records for extraction and normalization (sample)', benchmark: 'lab' },
  'lab/nidaankosha_lab_readings_sample.json': { domain: 'laboratory results', likelyPurpose: 'JSON sample of nidaankosha lab readings', benchmark: null, note: '1000 rows vs 15000 in the CSV sample; relationship unverified' },
  'lab/nidaankosha_part1.parquet': { domain: 'laboratory results', likelyPurpose: 'full lab readings, part 1 (inventory only; not read by the TypeScript adapters)', benchmark: null },
  'lab/nidaankosha_part2.parquet': { domain: 'laboratory results', likelyPurpose: 'full lab readings, part 2 (inventory only)', benchmark: null, note: 'same row count as part 1; overlap between parts is unchecked' },
  'pathology/icmr_pathology_cohorts.json': { domain: 'pathology dataset catalogue', likelyPurpose: 'descriptions of cohorts held elsewhere (metadata, not patient records)', benchmark: null },
  'pathology/sample_pathology_cases.json': { domain: 'pathology reports', likelyPurpose: 'sample pathology case narratives with structured fields', benchmark: 'pathology', note: 'narrative fields; blocked from external providers by default; only 2 cases' },
  'pharmacology/indian_drug_brand_salts.csv': { domain: 'drug brand / salt mapping', likelyPurpose: 'multiple-choice brand-to-generic mapping questions', benchmark: 'drug_brand' },
  'pharmacology/indian_drug_brand_salts.parquet': { domain: 'drug brand / salt mapping', likelyPurpose: 'columnar copy of indian_drug_brand_salts.csv', benchmark: null, twinOf: 'pharmacology/indian_drug_brand_salts.csv' },
  'pharmacology/eka_nfi_drug_pharmacology.csv': { domain: 'drug pharmacology', likelyPurpose: 'pharmacology multiple-choice questions with explanations', benchmark: 'pharmacology_mcq' },
  'pharmacology/eka_nfi_drug_pharmacology.parquet': { domain: 'drug pharmacology', likelyPurpose: 'columnar copy of eka_nfi_drug_pharmacology.csv', benchmark: null, twinOf: 'pharmacology/eka_nfi_drug_pharmacology.csv' },
};
/** Columns that are restricted from external processing regardless of the automatic indicators (narratives, patient-linked ids). */
export const FORCED_RESTRICTED: Record<string, string[]> = {
  'pathology/sample_pathology_cases.json': ['specimen', 'clinical_history', 'gross_description', 'microscopic_examination', 'case_id'],
  'clinical_eval/indian_protocols_clinical_qna.csv': ['patient_case', 'doctor_query', 'doctor_persona', 'scenario'],
  'clinical_eval/indian_protocols_clinical_qna.parquet': ['patient_case', 'doctor_query', 'doctor_persona', 'scenario'],
  'lab/nidaankosha_lab_readings_sample.csv': ['document_id', 'age', 'gender'], 'lab/nidaankosha_lab_readings_sample.json': ['document_id', 'age', 'gender'],
  'lab/nidaankosha_part1.parquet': ['document_id', 'age', 'gender'], 'lab/nidaankosha_part2.parquet': ['document_id', 'age', 'gender'],
};
