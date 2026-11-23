/**
 * OpenAPI 3.1 contract for /v1. Kept in code so a contract test can assert that
 * every implemented route is documented and every documented route exists.
 * `npm run openapi:v1` writes docs/openapi-v1.json.
 */
const Err = { $ref: '#/components/schemas/Error' };
const json = (schema: object) => ({ 'application/json': { schema } });
const errs = {
  401: { description: 'Missing/invalid API key or token', content: json(Err) },
  404: { description: 'Not found or not owned by this tenant', content: json(Err) },
  429: { description: 'Rate limit, quota or concurrency limit', content: json(Err) },
  503: { description: 'Limits store or auth not configured', content: json(Err) },
};
const idem = { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 8, maxLength: 200 } };
const p = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } });
const op = (summary: string, extra: Record<string, unknown> = {}, responses: Record<string, unknown> = { 200: { description: 'OK' } }) =>
  ({ summary, security: [{ ApiKey: [] }, { Bearer: [] }], ...extra, responses: { ...responses, ...errs } });

export function buildOpenApiV1() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'ANUClaw BaaS API', version: '1.0.0',
      description: 'Document → observation → analysis → report workflow. Engineering contract only; outputs are drafts for qualified review, not diagnoses. Clinical sign-off is not available via the API.',
    },
    servers: [{ url: 'http://127.0.0.1:4000' }],
    components: {
      securitySchemes: {
        ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        Bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } } },
        AlphaFoldLookup: { type: 'object', required: ['id','schema','models','annotations','responseHash','cache','retrievedAt'], properties: {
          id: { type: 'string' }, schema: { const: 'anuclaw-alphafold/v1' }, operation: { enum: ['prediction','complex','uniprot','sequence','annotations'] },
          models: { type: 'array', items: { type: 'object', required: ['modelId','predicted','files','confidence','provenance'], properties: { modelId: { type: 'string' }, predicted: { const: true }, range: { type: ['object','null'], properties: { start: { type: 'integer' }, end: { type: 'integer' } } }, files: { type: 'array', items: { type: 'object', properties: { key: { enum: ['mmcif','bcif','pdb','pae','plddt'] }, url: { type: 'string', format: 'uri' } } } }, confidence: { type: 'object', description: 'Provider confidence and interface metrics; absent fields remain null' }, provenance: { type: 'object', description: 'Actual model producer, tool, version and creation date when supplied' } } } },
          annotations: { type: 'array', items: { type: 'object', properties: { evidenceClass: { enum: ['experimental','transferred','computational','unknown'] }, evidence: { type: ['string','null'] } } } },
          responseHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, cache: { enum: ['hit','miss','revalidated'] }, retrievedAt: { type: 'integer' }, warnings: { type: 'array', items: { type: 'object' } },
        } },
        Correction: { type: 'object', properties: { analyte: { type: 'string' }, valueRaw: { type: 'string' }, unit: { type: ['string', 'null'] }, refLow: { type: ['number', 'null'] }, refHigh: { type: ['number', 'null'] } } },
      },
    },
    paths: {
      '/v1/openapi.json': { get: { summary: 'This contract', responses: { 200: { description: 'OpenAPI document' } } } },
      '/v1/engines': { get: op('Enabled engines, rule release state and model roles') },
      '/v1/spend': { get: op('This tenant\'s model spend: provider-reported cost only; unknown cost is counted separately and totals are marked as lower bounds', { parameters: [{ name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }] }) },
      '/v1/specialties': { get: op('Specialty modules: what is implemented, release state, approval status and open external requirements') },
      '/v1/patients': { post: op('Create a tenant-owned patient subject', { parameters: [idem], requestBody: { required: true, content: json({ type: 'object', required: ['display_name'], properties: { display_name: { type: 'string', maxLength: 200 }, external_ref: { type: 'string' } } }) } }, { 201: { description: 'Created' }, 400: { description: 'Validation', content: json(Err) } }) },
      '/v1/patients/{patientId}/documents': {
        get: op('List documents', { parameters: [p('patientId')] }),
        post: op('Upload a document (PDF/PNG/JPEG/text; content-sniffed)', { parameters: [p('patientId'), idem], requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file', 'purpose'], properties: { file: { type: 'string', format: 'binary' }, purpose: { type: 'string' } } } } } } },
          { 201: { description: 'Ingested; per-page extraction status' }, 409: { description: 'Duplicate', content: json(Err) }, 413: { description: 'Too large', content: json(Err) }, 415: { description: 'Unsupported type', content: json(Err) } }),
      },
      '/v1/patients/{patientId}/observations': { get: op('Confirmed/corrected observations', { parameters: [p('patientId')] }) },
      '/v1/documents/{documentId}': { get: op('Document review: pages, candidates (with uncertainty flags), observations', { parameters: [p('documentId')] }) },
      '/v1/candidates/{candidateId}/decision': { post: op('Confirm / correct (reason required) / reject an extracted candidate', { parameters: [p('candidateId'), idem], requestBody: { required: true, content: json({ type: 'object', required: ['action'], properties: { action: { enum: ['confirm', 'correct', 'reject'] }, correction: { $ref: '#/components/schemas/Correction' }, reason: { type: 'string' } } }) } }, { 200: { description: 'Decided' }, 409: { description: 'Already decided', content: json(Err) } }) },
      '/v1/observations/{observationId}/correction': { post: op('Correct an observation (new revision; supersedes dependent snapshots/reports)', { parameters: [p('observationId'), idem], requestBody: { required: true, content: json({ type: 'object', required: ['correction', 'reason'], properties: { correction: { $ref: '#/components/schemas/Correction' }, reason: { type: 'string' } } }) } }) },
      '/v1/documents/{documentId}/snapshots': { post: op('Create an immutable hashed case snapshot (blocked while candidates are pending)', { parameters: [p('documentId'), idem] }, { 201: { description: 'Created' }, 409: { description: 'Confirmation pending / extraction failed', content: json(Err) } }) },
      '/v1/snapshots/{snapshotId}/analyses': { post: op('Run released rules; returns a server-owned execution record', { parameters: [p('snapshotId'), idem] }, { 201: { description: 'Execution record' }, 409: { description: 'Snapshot superseded', content: json(Err) } }) },
      '/v1/jobs/{jobId}': { get: op('Execution record status', { parameters: [p('jobId')] }) },
      '/v1/snapshots/{snapshotId}/reports': { post: op('Create a draft report from a verified analysis of this snapshot', { parameters: [p('snapshotId'), idem], requestBody: { required: true, content: json({ type: 'object', required: ['analysis_id'], properties: { analysis_id: { type: 'string' } } }) } }, { 201: { description: 'Draft report' }, 409: { description: 'Analysis not for this snapshot / integrity failure', content: json(Err) } }) },
      '/v1/reports/{reportId}': { get: op('Structured report (SOAP + plain language + provenance)', { parameters: [p('reportId')] }) },
      '/v1/reports/{reportId}/review': { post: op('Not available via API (clinician sign-off is dashboard-only)', { parameters: [p('reportId')] }, { 403: { description: 'Always', content: json(Err) } }) },
      '/v1/reports/{reportId}/export.html': { get: op('HTML export (X-Content-SHA256, X-Report-Status)', { parameters: [p('reportId')] }, { 200: { description: 'HTML', content: { 'text/html': {} } } }) },
      '/v1/reports/{reportId}/export.pdf': { get: op('PDF export (X-Content-SHA256, X-Report-Status)', { parameters: [p('reportId')] }, { 200: { description: 'PDF', content: { 'application/pdf': {} } } }) },
      '/v1/science': { get: op('Public scientific-data connectors (AlphaFold DB, RCSB PDB, NCBI Datasets, GEO): limits, terms and classifications. RESEARCH-ONLY; not clinical evidence.') },
      '/v1/science/alphafold/lookup': { post: op('Official AlphaFold DB metadata, normalized as anuclaw-alphafold/v1; all models and fragments retained. Public provider, private tenant association. Cached data is labelled.', { requestBody: { required: true, content: json({ type: 'object', additionalProperties: false, required: ['operation', 'value'], properties: { operation: { enum: ['prediction', 'complex', 'uniprot', 'sequence', 'annotations'] }, value: { type: 'string', maxLength: 10000, description: 'UniProt accession/model ID, or 20–2700 standard amino acids for sequence operation. Never send patient identifiers.' }, refresh: { type: 'boolean' } } }) } }, { 200: { description: 'Versioned normalized models, annotations, coverage, warnings, retrieval timestamp, cache status and raw metadata SHA-256', content: json({ $ref: '#/components/schemas/AlphaFoldLookup' }) }, 400: { description: 'Invalid qualifier or sequence' }, 502: { description: 'Malformed provider response, schema change or upstream failure' }, 504: { description: 'Bounded provider timeout' } }) },
      '/v1/science/alphafold/lookups/{id}': { get: op('Read a normalized lookup belonging to this tenant', { parameters: [p('id')] }) },
      '/v1/science/alphafold/import': { post: op('Explicitly import ONE advertised AlphaFold file. Origin/redirect/size/content validation; immutable SHA-256 artifact. No automatic docking.', { requestBody: { required: true, content: json({ type: 'object', additionalProperties: false, required: ['lookupId','modelId','fileKey'], properties: { lookupId: { type: 'string' }, modelId: { type: 'string' }, fileKey: { enum: ['mmcif','bcif','pdb','pae','plddt'] } } }) } }, { 201: { description: 'Scoped import ID, immutable source and attribution/provenance' }, 413: { description: 'Artifact exceeds size cap' }, 502: { description: 'Provider failure or content-type/format mismatch' } }) },
      '/v1/science/alphafold/imports/{id}': { get: op('Read scoped import provenance and integrity status', { parameters: [p('id')] }) },
      '/v1/science/search': { post: op('Search a public provider (RCSB, NCBI genomes by taxon, GEO). Private to the tenant; the text is sent to the provider — never include identifiers', { requestBody: { required: true, content: json({ type: 'object', required: ['provider', 'query'], properties: { provider: { enum: ['rcsb', 'ncbi_datasets', 'geo'] }, query: { type: 'string', maxLength: 200 } } }) } }) },
      '/v1/science/describe': { post: op('Describe a public record by accession: metadata, classification (experimental / predicted / author_supplied / curated_reference), version, terms, available files', { requestBody: { required: true, content: json({ type: 'object', required: ['provider', 'accession'], properties: { provider: { enum: ['alphafold', 'rcsb', 'ncbi_datasets', 'geo'] }, accession: { type: 'string' } } }) } }) },
      '/v1/science/retrieve': { post: op('Retrieve selected files of a public record: stored immutably with checksum, URL, retrieval time, licence and attribution; parsed summaries are kept separately', { requestBody: { required: true, content: json({ type: 'object', required: ['provider', 'accession', 'files'], properties: { provider: { type: 'string' }, accession: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, refresh: { type: 'boolean', description: 'Bypass the cache for this call; a changed file becomes a new immutable version' } } }) } }, { 201: { description: 'Sources (provenance records) and per-file problems' } }) },
      '/v1/science/sources/{sourceId}': { get: op('Provenance, integrity status and parser summaries of a source this tenant retrieved', { parameters: [p('sourceId')] }) },
      '/v1/science/sources/{sourceId}/content': { get: op('The stored bytes (re-hashed before serving; a mismatch is refused)', { parameters: [p('sourceId')] }, { 200: { description: 'Bytes with X-Content-SHA256' } }) },
      '/v1/science/workspaces': { get: op('This tenant\'s research workspaces'), post: op('Create a research workspace (name + purpose)', { requestBody: { required: true, content: json({ type: 'object', required: ['name', 'purpose'], properties: { name: { type: 'string' }, purpose: { type: 'string' } } }) } }, { 201: { description: 'Created' } }) },
      '/v1/science/workspaces/{workspaceId}': { get: op('A workspace with its pinned source items', { parameters: [p('workspaceId')] }) },
      '/v1/science/workspaces/{workspaceId}/items': { post: op('Pin a retrieved source version to a workspace', { parameters: [p('workspaceId')], requestBody: { required: true, content: json({ type: 'object', required: ['sourceId'], properties: { sourceId: { type: 'string' }, label: { type: 'string' } } }) } }, { 201: { description: 'Attached' }, 409: { description: 'Already attached', content: json(Err) } }) },
      '/v1/science/workspaces/{workspaceId}/manifest': { get: op('Manifest of the workspace: sources, checksums (re-verified at export), provenance, licences, derived summaries, research-only notice', { parameters: [p('workspaceId')] }) },
      '/v1/interpretations': {
        post: op('Submit a tenant app\'s AI output (interpretation-request/v1) for asynchronous interpretation. Identity is split off into an encrypted vault; the job is queued. Replay with the same Idempotency-Key and body returns the original job (200).', { parameters: [idem], requestBody: { required: true, content: json({ type: 'object', description: 'interpretation-request/v1 (see src/interpretation/contracts)' }) } },
          { 202: { description: 'Accepted; poll the Location' }, 200: { description: 'Idempotent replay of an earlier request' }, 400: { description: 'Validation', content: json(Err) }, 403: { description: 'Skill not assigned / disabled / not released', content: json(Err) }, 409: { description: 'Idempotency-Key reused with a different body', content: json(Err) }, 503: { description: 'Skill or identity storage unavailable', content: json(Err) } }),
        get: op('This tenant\'s interpretation jobs (limit/offset). Polling is not counted against the monthly quota.', { parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }, { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } }] }),
      },
      '/v1/interpretations/{id}': { get: op('Status of one interpretation job (queued, processing, completed, failed)', { parameters: [p('id')] }) },
      '/v1/interpretations/{id}/findings': { get: op('Normalized findings (normalized-findings/v1) for a completed job; 409 until then', { parameters: [p('id')] }, { 200: { description: 'normalized-findings/v1' }, 409: { description: 'Not ready', content: json(Err) }, 410: { description: 'The subject\'s data was erased', content: json(Err) } }) },
      '/v1/interpretations/{id}/reports': { get: op('Report versions of an interpretation with status and review state (no content)', { parameters: [p('id')] }, { 200: { description: 'Versions, newest first' }, 404: { description: 'Not found', content: json(Err) }, 410: { description: 'The subject\'s data was erased', content: json(Err) } }) },
      '/v1/interpretations/{id}/report': { get: op('The current ready report as one layer (clinical or layman) in json, html or pdf. Both layers come from the same findings. The status banner states the review state (ai_reviewed, awaiting_clinician, clinician_signed or rejected); nothing is signed unless a named, provisioned clinician signed it, and no API route signs. A signed report is a new version.', { parameters: [p('id'), { name: 'layer', in: 'query', required: true, schema: { enum: ['clinical', 'layman'] } }, { name: 'format', in: 'query', schema: { enum: ['json', 'html', 'pdf'], default: 'json' } }] }, { 200: { description: 'The report (json | text/html | application/pdf)' }, 400: { description: 'Validation', content: json(Err) }, 404: { description: 'Not found or no report', content: json(Err) }, 409: { description: 'report_not_ready', content: json(Err) }, 410: { description: 'The subject\'s data was erased', content: json(Err) }, 503: { description: 'pdf_renderer_unavailable (html still works)', content: json(Err) } }) },
      '/v1/subject-erasures': {
        post: op('PERMANENTLY erase everything held about one subject of this tenant (identity, source payloads, findings, webhook payload bytes). Jobs remain as tombstones; the audit chain (job ids and hashes only) is append-only and keeps one new entry. Body: { externalRef, confirm: true, reason? }. Idempotent: erasing again erases nothing and returns a receipt of zeros.', { requestBody: { required: true, content: json({ type: 'object', required: ['externalRef', 'confirm'], properties: { externalRef: { type: 'string', maxLength: 128 }, confirm: { const: true }, reason: { enum: ['subject_request', 'consent_withdrawn', 'tenant_request', 'other'] } } }) } },
          { 200: { description: 'Receipt: counts and the erased job ids' }, 400: { description: 'Validation or confirmation_required', content: json(Err) } }),
        get: op('This tenant\'s erasure receipts (counts and a hash of the erased job ids; never a subject reference)', { parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }, { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } }] }),
      },
      '/v1/evidence/search': { get: op('Search approved reference content (global + this tenant); explicit no_evidence', { parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string', maxLength: 1000 } }, { name: 'k', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 20 } }] }) },
    },
  };
}
