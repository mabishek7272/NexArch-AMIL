/**
 * Referral advisory text (interpretation engine, P4). STATIC wording: no model ever writes, shortens, softens or
 * reorders it, and the report assembler inserts it from here, never from a narrative.
 *
 * STATUS: DRAFT, pending clinician approval. The wording is deliberately conservative: it makes no diagnosis, gives no
 * reassurance, names no condition, and asks the reader to see a doctor or other qualified professional. The version
 * string ends in `-draft` until a licensed clinician releases it through `docs/clinical-release-register.json`; then
 * edit this file, drop the suffix and bump the version. The `status` field is metadata for reviewers and is not
 * shown to the patient.
 */
export const ADVISORY_ID = 'referral-advisory';
export const ADVISORY_VERSION = '1.0.0-draft';
export const ADVISORY_STATUS = 'draft_pending_clinician_approval' as const;

export interface AdvisoryText { id: string; version: string; status: typeof ADVISORY_STATUS; layman: string; clinical: string; safetyNet: string }

export const ADVISORY: AdvisoryText = {
  id: ADVISORY_ID,
  version: ADVISORY_VERSION,
  status: ADVISORY_STATUS,
  layman:
    'Some results in this report are outside the range used by the app that produced them, or could not be checked reliably. ' +
    'This report is not a diagnosis. Please arrange to see a doctor or another qualified health professional soon to talk about these results ' +
    'and to have them checked with proper tests. Please do not start, stop or change any medicine because of this report.',
  clinical:
    'Automated review found findings that warrant professional assessment: one or more values lie outside the reference supplied by the source application, ' +
    'are flagged high-risk by the source, or carry unresolved data-quality flags. The source is not a diagnostic device. ' +
    'These findings require confirmation with validated measurements and clinical correlation by a qualified professional.',
  safetyNet:
    'Seek urgent medical care straight away if you have chest pain, difficulty breathing, fainting, confusion, sudden weakness or trouble speaking, ' +
    'or any symptom that worries you.',
};
