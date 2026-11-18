/**
 * OpenAPI 3.1 contract for the authenticated OCR-study API (mounted by the dashboard server at /api/ocr-study; cookie or bearer dashboard session).
 * A contract test asserts that every implemented route is documented and every documented operation exists. `npm run openapi:study` writes docs/openapi-ocr-study.json.
 * STUDY TOOLING ONLY: synthetic data does not establish OCR accuracy, clinical validation or release approval.
 */
import { MATRIX, Perm } from '../../dashboard/server/ocr-study-access';
import { STUDY_NOTICE } from './workspace';

type Op = { method: 'get' | 'post' | 'put'; path: string; summary: string; perm: Perm | 'member' | 'any_authenticated' | 'always_403'; body?: Record<string, string>; ok?: number };
const DS = '/studies/{id}/datasets/{ds}';
export const OPS: Op[] = [
  { method: 'get', path: '/', summary: 'Overview: notice, storage status (fail-closed reasons), roles, permission matrix, my studies', perm: 'any_authenticated' },
  { method: 'post', path: '/studies', summary: 'Create a study; the signed-in user becomes study_owner (tenant derived from the session)', perm: 'any_authenticated', body: { name: 'string', purpose: 'string' }, ok: 201 },
  { method: 'get', path: '/studies/{id}', summary: 'Study summary (members and annotator identities are shown only to roles that need them; annotators see only assigned datasets)', perm: 'view_study' },
  { method: 'post', path: '/studies/{id}/members', summary: 'Add a member by email with ONE study role (cannot be combined)', perm: 'manage_members', body: { memberEmail: 'string', studyRole: 'enum StudyRole' }, ok: 201 },
  { method: 'get', path: '/studies/{id}/members', summary: 'All members with status (active/suspended/removed) and open two-person requests; paginated (limit<=200)', perm: 'view_members' },
  { method: 'post', path: '/studies/{id}/members/{uid}/suspend', summary: 'Suspend a member immediately (reason required; only its hash and length are audited). Custodians and clinical leads need the two-person flow (409 second_authorization_required). The last active study owner cannot be suspended. Nothing is deleted', perm: 'manage_members', body: { reason: 'string', reauthPassword: 'string (policy)' } },
  { method: 'post', path: '/studies/{id}/members/{uid}/remove', summary: 'Remove a member immediately and permanently for this study (history stays attributable; a removed member cannot be re-added). Same rules as suspend', perm: 'manage_members', body: { reason: 'string', reauthPassword: 'string (policy)' } },
  { method: 'post', path: '/studies/{id}/members/{uid}/reinstate', summary: 'Reinstate a SUSPENDED member', perm: 'manage_members', body: { reason: 'string', reauthPassword: 'string (policy)' } },
  { method: 'post', path: '/studies/{id}/members/{uid}/requests', summary: 'Request suspension/removal of a dataset custodian or clinical lead (first of two people)', perm: 'manage_members', body: { action: 'suspend|remove', reason: 'string', reauthPassword: 'string (policy)' }, ok: 201 },
  { method: 'post', path: '/studies/{id}/members/{uid}/requests/{rid}/approve', summary: 'Approve a request: a study owner or clinical lead who is neither the requester nor the member concerned', perm: 'approve_member_action', body: { reason: 'string', reauthPassword: 'string (policy)' } },
  { method: 'post', path: '/studies/{id}/members/{uid}/requests/{rid}/execute', summary: 'Execute an approved request (the requester); single use', perm: 'manage_members', body: { reauthPassword: 'string (policy)' } },
  { method: 'get', path: '/studies/{id}/policy', summary: 'The OCR study policy record (?kind=real_study|synthetic_test): fields with configuration status, version history with chain verification, effective state. A real-study policy is NEVER effective in this build', perm: 'view_policy' },
  { method: 'put', path: '/studies/{id}/policy', summary: 'Save a new immutable DRAFT version of a policy: fields {value, sourceRef} (real-study fields need a source reference; presence is not verification) or null to un-configure. Cannot activate anything', perm: 'edit_policy', body: { kind: 'real_study|synthetic_test', fields: 'object', clinicalLeadDecisionRef: 'string', independentReviewRef: 'string', reauthPassword: 'string (policy)' }, ok: 201 },
  { method: 'post', path: '/studies/{id}/policy/activate', summary: 'Request activation of the real-study policy. ALWAYS refused in this build (409 activation_blocked): needs an external authorization reference, an independent-review reference and an approved-protocol gate that does not exist; the refusal is audited', perm: 'edit_policy', body: { authorizationRef: 'string', independentReviewRef: 'string' } },
  { method: 'get', path: '/studies/{id}/policy/reviews', summary: 'Draft-policy review submissions and decisions (metadata and external references only; references are never treated as verification)', perm: 'view_policy' },
  { method: 'post', path: '/studies/{id}/policy/reviews', summary: 'Submit the CURRENT real-study draft policy version for two-person review (never activates anything)', perm: 'edit_policy', body: { note: 'string (only a hash and length are stored in audit)', reauthPassword: 'string (policy)' }, ok: 201 },
  { method: 'post', path: '/studies/{id}/policy/reviews/{rid}/decision', summary: 'Record a review (reviewed | changes_requested) with EXTERNAL decision and signature references. Refused: self-review, stale version, replay, tampered chain. Does not activate or approve; cannot enable real data', perm: 'review_policy', body: { decision: 'reviewed|changes_requested', externalDecisionRef: 'string', externalSignatureRef: 'string', note: 'string', reauthPassword: 'string (policy)' }, ok: 201 },
  { method: 'get', path: '/studies/{id}/policy/readiness', summary: 'Readiness report: missing fields, source references, external decision/review references and unavailable infrastructure gates, each linked to its owning document. Always "not eligible for activation"', perm: 'view_policy' },
  { method: 'get', path: '/studies/{id}/policy/report', summary: 'Policy comparison / audit report: every field, configuration status, source-reference presence (not verification), affected code paths, and the policy version used by each run', perm: 'view_policy' },
  { method: 'put', path: '/studies/{id}/severity-map', summary: 'Set descriptive severity labels per error type: writes a new version of the SYNTHETIC test policy chain (cannot accept a study)', perm: 'configure_severity', body: { map: 'object errorType→label' } },
  { method: 'post', path: '/studies/{id}/acceptance', summary: 'Always 403: no role can mark a study accepted in this software', perm: 'always_403' },
  { method: 'post', path: '/studies/{id}/datasets', summary: 'Register a SYNTHETIC dataset (real data refused by the synthetic-only storage adapter); assigns two annotators blind to each other', perm: 'register_dataset', body: { name: 'string', studyRef: 'string', provenanceKind: 'synthetic_fixture', split: 'enum Split', origin: 'string', annotatorEmails: 'string[2]', sources: 'array of {contentBase64,pages,mediaType}' }, ok: 201 },
  { method: 'post', path: `${DS}/attestation`, summary: 'Record a human-supplied de-identification attestation (hashed; not verified by the software)', perm: 'attest', body: { record: 'AttestationRecord' }, ok: 201 },
  { method: 'post', path: `${DS}/manifest`, summary: 'Generate the manifest (requires the attestation)', perm: 'manifest', ok: 201 },
  { method: 'get', path: `${DS}/manifest`, summary: 'Manifest and server-derived lock state', perm: 'view_manifest' },
  { method: 'post', path: `${DS}/verify`, summary: 'Verify integrity; a locked dataset REQUIRES expectedLockDigest recorded outside this system', perm: 'verify', body: { expectedLockDigest: 'hex64 (required when locked)' } },
  { method: 'get', path: `${DS}/cases`, summary: 'Cases (opaque ids, pages, media type); annotators only for datasets assigned to them', perm: 'list_cases' },
  { method: 'get', path: `${DS}/cases/{caseId}/source`, summary: 'Source bytes (hash re-checked); assigned annotators and the custodian only', perm: 'read_source' },
  { method: 'post', path: `${DS}/annotations`, summary: 'Import the signed-in annotator\'s own annotation file as a new immutable version', perm: 'import_annotations', body: { file: 'AnnotatorFile' }, ok: 201 },
  { method: 'get', path: `${DS}/my-annotations`, summary: 'The signed-in annotator\'s OWN versions only', perm: 'own_annotations' },
  { method: 'get', path: `${DS}/agreement`, summary: 'Aggregate agreement and missingness; no item-level disagreement content', perm: 'agreement_summary' },
  { method: 'get', path: `${DS}/queue`, summary: 'Disagreement queue with annotator identities replaced by A/B', perm: 'review_queue' },
  { method: 'post', path: `${DS}/adjudications`, summary: 'Submit an adjudication; both original annotations are preserved; annotation files are never altered', perm: 'adjudicate', body: { queueId: 'string', source: 'A|B|other|ambiguous', finalValue: 'any (source other)', reason: 'string' }, ok: 201 },
  { method: 'get', path: `${DS}/adjudications`, summary: 'Adjudication records (annotator identities hidden)', perm: 'review_queue' },
  { method: 'post', path: `${DS}/truth`, summary: 'Build the adjudicated truth (refused while disagreements are unresolved)', perm: 'build_truth', ok: 201 },
  { method: 'post', path: `${DS}/lock`, summary: 'Lock the dataset; returns the lock digest to record OUTSIDE this system', perm: 'lock', ok: 201 },
  { method: 'post', path: `${DS}/unlock-requests`, summary: 'Request an unlock (custodian); bound to the current manifest hash and lock digest', perm: 'request_unlock', body: { reason: 'string' }, ok: 201 },
  { method: 'get', path: `${DS}/unlock-requests`, summary: 'Unlock requests and their status', perm: 'view_manifest' },
  { method: 'post', path: `${DS}/unlock-requests/{rid}/authorize`, summary: 'Authorize an unlock (study owner / clinical lead); must be a different authenticated user from the requester; single use', perm: 'authorize_unlock', body: { reason: 'string', protocolDeviationRef: 'string', credentialRef: 'string', roleClaim: 'string' }, ok: 201 },
  { method: 'post', path: `${DS}/unlock-requests/{rid}/execute`, summary: 'Execute an authorized unlock (the requester); refused on replay, manifest/lock-digest mismatch or tenant mismatch', perm: 'execute_unlock' },
  { method: 'post', path: `${DS}/evaluations`, summary: 'Run an evaluation (development only on the development split; locked mode requires the lock and expectedLockDigest); severity labels come from the study, not the body', perm: 'evaluate', body: { runId: 'string', mode: 'development|locked', results: 'anuclaw-ocr-extraction/v1 (locked mode: must carry the policy stamp it was produced under)', expectedLockDigest: 'hex64 (locked)' }, ok: 201 },
  { method: 'post', path: `${DS}/evaluations/{runId}/export`, summary: 'Export the evaluation report (POST so a re-authentication password can be supplied; hash in X-Report-SHA256; states clinicalAcceptance not assessed). Sensitive: re-authentication policy applies', perm: 'export_report', body: { reauthPassword: 'string (when the policy requires it)' } },
  { method: 'get', path: '/studies/{id}/audit', summary: 'Audit events (identifiers, hashes, counts only) and the file-store audit chain check', perm: 'view_audit' },
];

export function buildOcrStudyOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const o of OPS) {
    const roles = o.perm === 'any_authenticated' ? 'any authenticated dashboard user (admin, operator, clinician, auditor, compliance)' : o.perm === 'member' ? 'any study member' : o.perm === 'always_403' ? 'no role' : MATRIX[o.perm].join(', ');
    (paths[o.path] ??= {})[o.method] = {
      summary: o.summary, description: `Allowed study roles: ${roles}. ${STUDY_NOTICE}`, security: [{ DashboardSession: [] }, { Bearer: [] }],
      parameters: [...(o.path.includes('{id}') ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^w-[0-9a-f]{12}$' } }] : []), ...(o.path.includes('{uid}') ? [{ name: 'uid', in: 'path', required: true, schema: { type: 'string' } }] : []), ...(o.path.includes('{ds}') ? [{ name: 'ds', in: 'path', required: true, schema: { type: 'string' } }] : []),
        ...(o.path.includes('{caseId}') ? [{ name: 'caseId', in: 'path', required: true, schema: { type: 'string' } }] : []), ...(o.path.includes('{rid}') ? [{ name: 'rid', in: 'path', required: true, schema: { type: 'string' } }] : []), ...(o.path.includes('{runId}') ? [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }] : [])],
      ...(o.body ? { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'Fields (the body may NOT carry userId, tenantId, role or lockState; such requests get 400 forbidden_field).', properties: Object.fromEntries(Object.entries(o.body).map(([k, v]) => [k, { description: v }])) } } } } } : {}),
      responses: { [String(o.ok ?? 200)]: { description: 'OK' }, 400: { description: 'Bad input / forbidden_field / expected_lock_digest_required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },         403: { description: 'Study role does not permit this; csrf_refused', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, 404: { description: 'Not found, or not a member (same answer)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        401: { description: 'Not authenticated, or re-authentication required (reauth_required/reauth_failed)' }, 413: { description: 'too_large: body or file exceeds study limits' }, 429: { description: 'rate_limited (Retry-After set)' }, 409: { description: 'State conflict (locked, integrity, mismatch, replay, last_owner)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, 503: { description: 'study_storage_unavailable (fails closed) or authentication not configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
    };
  }
  return {
    openapi: '3.1.0', info: { title: 'ANUClaw OCR study workspace API', version: '1.0.0', description: `${STUDY_NOTICE} Identity, tenant, study role and lock state are derived by the server from the dashboard session and database membership, never from request bodies. Storage fails closed unless configured; only a synthetic local adapter exists.` },
    servers: [{ url: 'http://127.0.0.1:4100/api/ocr-study' }],
    components: { securitySchemes: { DashboardSession: { type: 'apiKey', in: 'cookie', name: 'dash_token' }, Bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: { Error: { type: 'object', required: ['error', 'code'], properties: { error: { type: 'string' }, code: { type: 'string' }, notice: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } } } } } },
    paths,
  };
}
