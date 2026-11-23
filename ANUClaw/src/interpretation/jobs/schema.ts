/**
 * Tables for asynchronous interpretation intake (interpretation engine, P3a). Run by the startup migration in
 * `src/db/connection.ts`; every statement is idempotent.
 *
 * - interpretation_jobs : one row per accepted request. Holds status, queue/lease fields and hashes, never payload
 *                         content or identifiers.
 * - source_payloads     : the tenant's request with `subject.identity` REMOVED, stored once and immutable (a trigger
 *                         refuses UPDATE). `payload_sha256` is the hash of exactly these stored bytes.
 * - identity_vault      : direct identifiers (name/email/phone/DOB), sealed with AES-256-GCM. Only read by erasure and
 *                         future authorised export; never by the worker, never by an LLM stage.
 * - normalized_findings : the adapter's output (normalized-findings/v1), one row per job.
 * - tenant_webhooks     : one webhook endpoint per tenant; the signing secret is stored sealed, never in the clear.
 * - subject_erasures    : a receipt per erasure request: counts and a hash of the erased job ids, never the subject reference or any identifier.
 * - interpretation_reports: one row per report version of a job. Moves queued -> generating -> governed -> narrating -> narrated -> ready. Holds the
 *                         governance document, both report layers, the guard and review results. Content columns are
 *                         immutable once set (a trigger); `clinician_signed` is impossible without a named signer (CHECK).
 * - webhook_deliveries  : the outbox. A row is written in the SAME transaction as the job state change it reports, so
 *                         a completed/failed job and its notification either both exist or neither does. The row
 *                         holds the exact bytes sent (ids and status only, no PHI) so every retry is identical.
 */
export const INTERPRETATION_SCHEMA_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS interpretation_jobs (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    skill_id VARCHAR(64) NOT NULL,
    analysis_type VARCHAR(64) NOT NULL,
    subject_ref VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(200),
    request_fingerprint VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','erased')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    run_after BIGINT NOT NULL,
    claim_token VARCHAR(64),
    lease_expires_at BIGINT,
    error_code VARCHAR(64),
    original_payload_sha256 VARCHAR(64),
    findings_sha256 VARCHAR(64),
    adapter_id VARCHAR(64),
    adapter_version VARCHAR(40),
    captured_at VARCHAR(40) NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    completed_at BIGINT)`,
  // Two requests with the same key can never both create a job: the database decides, not application code.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_interpretation_jobs_idem ON interpretation_jobs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_interpretation_jobs_queue ON interpretation_jobs(status, run_after)`,
  `CREATE INDEX IF NOT EXISTS idx_interpretation_jobs_tenant ON interpretation_jobs(tenant_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_interpretation_jobs_subject ON interpretation_jobs(tenant_id, subject_ref)`,

  `CREATE TABLE IF NOT EXISTS source_payloads (
    job_id VARCHAR(64) PRIMARY KEY REFERENCES interpretation_jobs(id) ON DELETE CASCADE,
    tenant_id VARCHAR(64) NOT NULL,
    schema_version VARCHAR(40) NOT NULL,
    payload_json TEXT NOT NULL,
    payload_sha256 VARCHAR(64) NOT NULL,
    created_at BIGINT NOT NULL)`,
  `CREATE OR REPLACE FUNCTION source_payloads_immutable() RETURNS trigger AS $$
   BEGIN RAISE EXCEPTION 'source_payloads rows are immutable'; END; $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_source_payloads_immutable ON source_payloads`,
  `CREATE TRIGGER trg_source_payloads_immutable BEFORE UPDATE ON source_payloads FOR EACH ROW EXECUTE FUNCTION source_payloads_immutable()`,

  `CREATE TABLE IF NOT EXISTS identity_vault (
    job_id VARCHAR(64) PRIMARY KEY REFERENCES interpretation_jobs(id) ON DELETE CASCADE,
    tenant_id VARCHAR(64) NOT NULL,
    subject_ref VARCHAR(128) NOT NULL,
    kid VARCHAR(40) NOT NULL,
    sealed TEXT NOT NULL,
    created_at BIGINT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_identity_vault_subject ON identity_vault(tenant_id, subject_ref)`,

  `CREATE TABLE IF NOT EXISTS normalized_findings (
    job_id VARCHAR(64) PRIMARY KEY REFERENCES interpretation_jobs(id) ON DELETE CASCADE,
    tenant_id VARCHAR(64) NOT NULL,
    findings_sha256 VARCHAR(64) NOT NULL,
    document_json TEXT NOT NULL,
    created_at BIGINT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS tenant_webhooks (
    tenant_id VARCHAR(64) PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret_kid VARCHAR(40) NOT NULL,
    secret_sealed TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    secret_rotated_at BIGINT NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id VARCHAR(64) PRIMARY KEY,
    event_id VARCHAR(64) NOT NULL,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    job_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    payload_json TEXT NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','delivered','dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    run_after BIGINT NOT NULL,
    claim_token VARCHAR(64),
    lease_expires_at BIGINT,
    last_status_code INTEGER,
    last_error VARCHAR(64),
    first_attempt_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    delivered_at BIGINT,
    dead_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_queue ON webhook_deliveries(status, run_after)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant ON webhook_deliveries(tenant_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS subject_erasures (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    requested_at BIGINT NOT NULL,
    actor VARCHAR(100) NOT NULL,
    reason VARCHAR(40) NOT NULL,
    jobs_erased INTEGER NOT NULL,
    identities_deleted INTEGER NOT NULL,
    payloads_deleted INTEGER NOT NULL,
    findings_deleted INTEGER NOT NULL,
    deliveries_scrubbed INTEGER NOT NULL,
    job_ids_sha256 VARCHAR(64) NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_subject_erasures_tenant ON subject_erasures(tenant_id, requested_at DESC)`,

  `ALTER TABLE subject_erasures ADD COLUMN IF NOT EXISTS reports_deleted INTEGER NOT NULL DEFAULT 0`,

  `CREATE TABLE IF NOT EXISTS interpretation_reports (
    id VARCHAR(64) PRIMARY KEY,
    job_id VARCHAR(64) NOT NULL REFERENCES interpretation_jobs(id) ON DELETE CASCADE,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    supersedes_id VARCHAR(64),
    status VARCHAR(12) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','generating','governed','narrating','narrated','ready','failed','superseded')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    run_after BIGINT NOT NULL,
    claim_token VARCHAR(64),
    lease_expires_at BIGINT,
    error_code VARCHAR(64),
    findings_sha256 VARCHAR(64) NOT NULL,
    governance_json TEXT,
    governance_sha256 VARCHAR(64),
    narrative_json TEXT,
    clinical_json TEXT,
    layman_json TEXT,
    narrative_mode VARCHAR(20) CHECK (narrative_mode IN ('model','deterministic','model_fallback')),
    model_requested VARCHAR(120),
    model_returned VARCHAR(120),
    prompt_versions_json TEXT,
    guard_results_json TEXT,
    ai_review_json TEXT,
    review_state VARCHAR(20) CHECK (review_state IN ('ai_reviewed','awaiting_clinician','clinician_signed','rejected')),
    reviewed_by VARCHAR(100),
    reviewed_at BIGINT,
    signed_content_sha256 VARCHAR(64),
    rejection_reason VARCHAR(500),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    ready_at BIGINT,
    CONSTRAINT chk_report_signed CHECK (review_state IS DISTINCT FROM 'clinician_signed' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND signed_content_sha256 IS NOT NULL)),
    CONSTRAINT chk_report_rejected CHECK (review_state IS DISTINCT FROM 'rejected' OR rejection_reason IS NOT NULL))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_interpretation_reports_version ON interpretation_reports(job_id, version)`,
  `CREATE INDEX IF NOT EXISTS idx_interpretation_reports_queue ON interpretation_reports(status, run_after)`,
  `CREATE INDEX IF NOT EXISTS idx_interpretation_reports_tenant ON interpretation_reports(tenant_id, created_at DESC)`,
  `CREATE OR REPLACE FUNCTION interpretation_reports_content_immutable() RETURNS trigger AS $$
   BEGIN
     IF (OLD.findings_sha256 IS DISTINCT FROM NEW.findings_sha256)
        OR (OLD.governance_json IS NOT NULL AND (OLD.governance_json IS DISTINCT FROM NEW.governance_json OR OLD.governance_sha256 IS DISTINCT FROM NEW.governance_sha256))
        OR (OLD.narrative_json IS NOT NULL AND OLD.narrative_json IS DISTINCT FROM NEW.narrative_json)
        OR (OLD.clinical_json IS NOT NULL AND OLD.clinical_json IS DISTINCT FROM NEW.clinical_json)
        OR (OLD.layman_json IS NOT NULL AND OLD.layman_json IS DISTINCT FROM NEW.layman_json) THEN
       RAISE EXCEPTION 'interpretation_reports content is immutable once set; create a new version instead';
     END IF;
     IF OLD.review_state = 'clinician_signed' AND (NEW.review_state IS DISTINCT FROM OLD.review_state OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
        OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.signed_content_sha256 IS DISTINCT FROM OLD.signed_content_sha256 OR NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id) THEN
       RAISE EXCEPTION 'a clinician sign-off cannot be changed or removed; create a new version instead';
     END IF;
     RETURN NEW;
   END; $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_interpretation_reports_content_immutable ON interpretation_reports`,
  `CREATE TRIGGER trg_interpretation_reports_content_immutable BEFORE UPDATE ON interpretation_reports FOR EACH ROW EXECUTE FUNCTION interpretation_reports_content_immutable()`,
  // A table created by an earlier build lacks the narrative column and the narrating/narrated stages: upgrade it in place.
  `ALTER TABLE interpretation_reports ADD COLUMN IF NOT EXISTS narrative_json TEXT`,
  `ALTER TABLE interpretation_reports DROP CONSTRAINT IF EXISTS interpretation_reports_status_check`,
  `ALTER TABLE interpretation_reports ADD CONSTRAINT interpretation_reports_status_check CHECK (status IN ('queued','generating','governed','narrating','narrated','assembling','ready','failed','superseded'))`,

  // Review (4d): who signed (user id), a follow-up marker for the clinician queue, the hash of both layers, and one webhook event per job, type AND report.
  `ALTER TABLE interpretation_reports ADD COLUMN IF NOT EXISTS reviewer_user_id VARCHAR(64)`,
  `ALTER TABLE interpretation_reports ADD COLUMN IF NOT EXISTS follow_up BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE interpretation_reports ADD COLUMN IF NOT EXISTS content_sha256 VARCHAR(64)`,
  `CREATE INDEX IF NOT EXISTS idx_interpretation_reports_review ON interpretation_reports(status, review_state, follow_up)`,
  `ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR(80) NOT NULL DEFAULT ''`,
  `DROP INDEX IF EXISTS uq_webhook_deliveries_event`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_deliveries_event_v2 ON webhook_deliveries(job_id, event_type, dedupe_key)`,

  // Tenant branding (4c): a product name and a logo, nothing else. The governance block, status banner and advisory are
  // generated by code and cannot be edited here. The logo is stored as base64 of a sniffed PNG/JPEG of at most 256 KB.
  `CREATE TABLE IF NOT EXISTS tenant_branding (
    tenant_id VARCHAR(64) PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    product_name VARCHAR(60),
    logo_mime VARCHAR(16) CHECK (logo_mime IN ('image/png','image/jpeg')),
    logo_base64 TEXT,
    updated_at BIGINT NOT NULL,
    CONSTRAINT chk_branding_logo CHECK ((logo_mime IS NULL) = (logo_base64 IS NULL)))`,
];
