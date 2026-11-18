import { Pool, types } from 'pg';
import { config } from '../config';
import { logger } from '../logger';
import { bootstrapFirstAdmin, SCHEMA_ADVISORY_LOCK_KEY } from './admin-bootstrap';

// Parse PostgreSQL INT8 (BIGINT) as JavaScript integers to prevent Date parsing errors on frontend
types.setTypeParser(20, parseInt);

let _pool: Pool | null = null;
let _migrationPromise: Promise<void> | null = null;

export function getDb(): Pool {
  if (!_pool) {
    _pool = new Pool({
      host: config.pg.host,
      port: config.pg.port,
      user: config.pg.user,
      password: config.pg.pass,
      database: config.pg.dbName,
    });
    _pool.on('error', (err) => {
      logger.error('Unexpected error on idle PostgreSQL client', err);
    });
    // Trigger migrations immediately on boot, and cache the promise
    _migrationPromise = migrate(_pool);
  }
  return _pool;
}

export async function ensureDbReady(): Promise<void> {
  getDb();
  if (_migrationPromise) {
    await _migrationPromise;
  }
}

/** Exported for integration tests (concurrent-migration checks). */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise concurrent migrations/bootstraps across processes (released at COMMIT/ROLLBACK).
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_ADVISORY_LOCK_KEY]);
    
    // Create tables in order
    await client.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id VARCHAR(255) PRIMARY KEY,
        channel VARCHAR(50) NOT NULL,
        name VARCHAR(255),
        created_at VARCHAR(100) NOT NULL,
        last_seen_at VARCHAR(100)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(255) PRIMARY KEY,
        group_id VARCHAR(255) NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        channel VARCHAR(50) NOT NULL,
        sender_id VARCHAR(255),
        sender_name VARCHAR(255),
        role VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        media_type VARCHAR(50),
        media_path VARCHAR(500),
        created_at VARCHAR(100) NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(255) PRIMARY KEY,
        group_id VARCHAR(255) NOT NULL UNIQUE REFERENCES groups(id) ON DELETE CASCADE,
        messages_json TEXT NOT NULL DEFAULT '[]',
        updated_at VARCHAR(100) NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id VARCHAR(255) PRIMARY KEY,
        group_id VARCHAR(255) NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        channel VARCHAR(50) NOT NULL,
        name VARCHAR(255) NOT NULL,
        cron VARCHAR(100) NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at VARCHAR(100),
        next_run_at VARCHAR(100),
        created_at VARCHAR(100) NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_facts (
        id SERIAL PRIMARY KEY,
        group_id VARCHAR(255) NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        key VARCHAR(255) NOT NULL,
        value TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        source VARCHAR(50) NOT NULL DEFAULT 'agent',
        superseded_by INTEGER REFERENCES memory_facts(id) ON DELETE SET NULL,
        created_at VARCHAR(100) NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_traces (
        id SERIAL PRIMARY KEY,
        group_id VARCHAR(255) NOT NULL,
        session_id VARCHAR(255),
        event VARCHAR(100) NOT NULL,
        data_json TEXT,
        created_at VARCHAR(100) NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dash_users (
        id VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        role VARCHAR(50) NOT NULL DEFAULT 'viewer',
        scope_json TEXT DEFAULT '{}',
        password_hash VARCHAR(255),
        created_at BIGINT NOT NULL,
        last_login_at BIGINT,
        terms_accepted_at BIGINT DEFAULT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL REFERENCES dash_users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        key_hash VARCHAR(255) NOT NULL,
        key_prefix VARCHAR(50) NOT NULL,
        scopes TEXT DEFAULT '["read"]',
        created_at BIGINT NOT NULL,
        last_used_at BIGINT,
        expires_at BIGINT,
        revoked INTEGER DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dash_sessions (
        jti VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL REFERENCES dash_users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL,
        revoked INTEGER DEFAULT 0,
        ip VARCHAR(50),
        user_agent TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id SERIAL PRIMARY KEY,
        ts BIGINT NOT NULL,
        actor_id VARCHAR(255),
        actor_type VARCHAR(50) DEFAULT 'user',
        action VARCHAR(255) NOT NULL,
        target_type VARCHAR(50),
        target_id VARCHAR(255),
        before_json TEXT,
        after_json TEXT,
        channel VARCHAR(50),
        group_id VARCHAR(255),
        ip VARCHAR(50),
        signature TEXT,
        meta TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id SERIAL PRIMARY KEY,
        group_id VARCHAR(255),
        skill VARCHAR(255),
        success INTEGER DEFAULT 1,
        latency_ms INTEGER,
        ts BIGINT NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pipelines (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        category VARCHAR(100) DEFAULT 'custom',
        nodes TEXT NOT NULL DEFAULT '[]',
        connections TEXT DEFAULT '[]',
        trigger_type VARCHAR(50) DEFAULT 'manual',
        schedule_cron VARCHAR(100),
        created_by VARCHAR(255),
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        active INTEGER DEFAULT 1,
        run_count INTEGER DEFAULT 0,
        last_run_at BIGINT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id VARCHAR(255) PRIMARY KEY,
        pipeline_id VARCHAR(255) NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        status VARCHAR(50) DEFAULT 'pending',
        inputs TEXT DEFAULT '{}',
        node_results TEXT DEFAULT '{}',
        final_output TEXT,
        artifacts TEXT DEFAULT '[]',
        started_at BIGINT,
        finished_at BIGINT,
        triggered_by VARCHAR(255),
        error TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id VARCHAR(255) PRIMARY KEY,
        uid VARCHAR(255) UNIQUE,
        name VARCHAR(255) NOT NULL,
        dob VARCHAR(100),
        sex VARCHAR(10),
        conditions TEXT DEFAULT '[]',
        medications TEXT DEFAULT '[]',
        genomic_profile TEXT DEFAULT '{}',
        risk_score DOUBLE PRECISION DEFAULT 0,
        risk_level VARCHAR(50) DEFAULT 'unknown',
        risk_factors TEXT DEFAULT '[]',
        ai_summary TEXT,
        trial_matches TEXT DEFAULT '[]',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        summary_updated_at BIGINT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS patient_analyses (
        id VARCHAR(255) PRIMARY KEY,
        patient_id VARCHAR(255) NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        skill VARCHAR(255) NOT NULL,
        prompt TEXT,
        result TEXT,
        artifacts TEXT DEFAULT '[]',
        ts BIGINT NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id VARCHAR(255) PRIMARY KEY,
        company_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        api_key VARCHAR(255) NOT NULL UNIQUE,
        plan VARCHAR(50) NOT NULL DEFAULT 'free',
        rate_limit_per_min INTEGER NOT NULL DEFAULT 10,
        monthly_quota INTEGER,
        usage_this_month INTEGER NOT NULL DEFAULT 0,
        usage_total INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(50) NOT NULL DEFAULT 'active',
        webhook_url VARCHAR(500),
        created_at VARCHAR(100) NOT NULL,
        last_active_at VARCHAR(100)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS api_usage_log (
        id SERIAL PRIMARY KEY,
        tenant_id VARCHAR(255) NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        endpoint VARCHAR(255) NOT NULL,
        skill VARCHAR(255),
        status_code INTEGER NOT NULL,
        latency_ms INTEGER,
        tokens_used INTEGER,
        created_at VARCHAR(100) NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS quota_resets (
        tenant_id VARCHAR(255) PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        reset_at VARCHAR(100) NOT NULL
      )
    `);

    // ── Patient access control (Phase 1, F01) — additive, idempotent ─────────
    // Access is granted per user per patient. Rows with no grant are inaccessible
    // to everyone until an admin explicitly assigns them.
    await client.query(`
      CREATE TABLE IF NOT EXISTS patient_access (
        patient_id VARCHAR(255) NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        user_id VARCHAR(255) NOT NULL REFERENCES dash_users(id) ON DELETE CASCADE,
        access_level VARCHAR(10) NOT NULL CHECK (access_level IN ('read', 'write', 'owner')),
        purpose VARCHAR(255) NOT NULL,
        granted_by VARCHAR(255) NOT NULL,
        granted_at BIGINT NOT NULL,
        PRIMARY KEY (patient_id, user_id)
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_patient_access_user ON patient_access(user_id)');
    await client.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS created_by VARCHAR(255)`);
    await client.query(`DO $$ BEGIN IF to_regclass('posture_reports') IS NOT NULL THEN ALTER TABLE posture_reports ADD COLUMN IF NOT EXISTS digest_status VARCHAR(40); ALTER TABLE posture_reports ADD COLUMN IF NOT EXISTS view_sha256 CHAR(64); END IF; END $$`);
    await client.query(`ALTER TABLE patient_analyses ADD COLUMN IF NOT EXISTS created_by VARCHAR(255)`);
    await client.query(`ALTER TABLE patient_analyses ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(30)`);
    await client.query(`ALTER TABLE patient_analyses ADD COLUMN IF NOT EXISTS status VARCHAR(30)`);

    // ── Scheduled tasks (Phase 1, F07): ONE table read by the scheduler and the
    // dashboard; every execution recorded in task_runs with its real outcome.
    await client.query(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        cron VARCHAR(100) NOT NULL,
        skill VARCHAR(255) NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        group_id VARCHAR(255),
        enabled INTEGER DEFAULT 1,
        last_run BIGINT,
        last_status VARCHAR(100),
        created_at BIGINT NOT NULL,
        created_by VARCHAR(255)
      )
    `);
    await client.query(`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS channel VARCHAR(50)`);
    await client.query(`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS updated_at BIGINT`);
    await client.query(`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS running_since BIGINT`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id SERIAL PRIMARY KEY,
        task_id VARCHAR(255) NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
        ts BIGINT NOT NULL,
        status VARCHAR(100),
        output TEXT,
        latency_ms INTEGER
      )
    `);
    for (const col of ['trigger VARCHAR(20)', 'error VARCHAR(255)', 'execution_mode VARCHAR(30)', 'finished_at BIGINT']) {
      await client.query(`ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS ${col}`);
    }
    // Additive copy of legacy channel tasks (old `tasks` table) — nothing deleted.
    await client.query(`
      INSERT INTO scheduled_tasks (id, name, cron, skill, prompt, group_id, channel, enabled, created_at, created_by)
      SELECT t.id, t.name, t.cron, '', t.prompt, t.group_id, t.channel, t.enabled, 0, 'legacy-tasks-table'
        FROM tasks t
       WHERE NOT EXISTS (SELECT 1 FROM scheduled_tasks s WHERE s.id = t.id)
    `);

    // ── API EHR store (Phase 1, F09): real tenant-scoped persistence ─────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ehr_patients (
        uid VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(255) NOT NULL,
        first_name VARCHAR(255) NOT NULL,
        last_name VARCHAR(255) NOT NULL,
        date_of_birth VARCHAR(10) NOT NULL,
        gender VARCHAR(32) NOT NULL,
        country_code VARCHAR(2) NOT NULL,
        match_key VARCHAR(600) NOT NULL,
        extra_json TEXT NOT NULL DEFAULT '{}',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_ehr_patients_tenant_match ON ehr_patients(tenant_id, match_key)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS ehr_records (
        id VARCHAR(64) PRIMARY KEY,
        tenant_id VARCHAR(255) NOT NULL,
        uid VARCHAR(64) NOT NULL REFERENCES ehr_patients(uid) ON DELETE CASCADE,
        kind VARCHAR(20) NOT NULL CHECK (kind IN ('diagnosis', 'prescription', 'lab_report')),
        payload_json TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_ehr_records_uid ON ehr_records(tenant_id, uid, created_at)');

    // ── Document workflow (Phase 2, plan §5/§7) ──────────────────────────────
    const docTables = [
      `CREATE TABLE IF NOT EXISTS documents (
        id VARCHAR(64) PRIMARY KEY, patient_id VARCHAR(255) NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        uploaded_by VARCHAR(255) NOT NULL, content_sha256 CHAR(64) NOT NULL, media_type VARCHAR(40) NOT NULL,
        byte_size INTEGER NOT NULL, page_count INTEGER, storage_key VARCHAR(255) NOT NULL, purpose VARCHAR(255) NOT NULL,
        status VARCHAR(30) NOT NULL, created_at BIGINT NOT NULL, UNIQUE (patient_id, content_sha256))`,
      `CREATE TABLE IF NOT EXISTS extraction_runs (
        id VARCHAR(64) PRIMARY KEY, document_id VARCHAR(64) NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        parser VARCHAR(60) NOT NULL, ocr_engine VARCHAR(80), status VARCHAR(20) NOT NULL, error VARCHAR(80), created_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS extraction_pages (
        run_id VARCHAR(64) NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE, page INTEGER NOT NULL,
        method VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL, text TEXT NOT NULL, ocr_confidence DOUBLE PRECISION,
        PRIMARY KEY (run_id, page))`,
      `CREATE TABLE IF NOT EXISTS observation_candidates (
        id VARCHAR(64) PRIMARY KEY, document_id VARCHAR(64) NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        run_id VARCHAR(64) NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE, data_json TEXT NOT NULL,
        flags_json TEXT NOT NULL, status VARCHAR(20) NOT NULL, decided_by VARCHAR(255), decided_at BIGINT)`,
      `CREATE TABLE IF NOT EXISTS observations (
        id VARCHAR(64) PRIMARY KEY, patient_id VARCHAR(255) NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        document_id VARCHAR(64) NOT NULL REFERENCES documents(id) ON DELETE CASCADE, candidate_id VARCHAR(64),
        analyte VARCHAR(120) NOT NULL, value_raw VARCHAR(60) NOT NULL, comparator VARCHAR(2), value_num DOUBLE PRECISION,
        unit VARCHAR(40), ref_low DOUBLE PRECISION, ref_high DOUBLE PRECISION, page INTEGER, method VARCHAR(20) NOT NULL,
        revision INTEGER NOT NULL, status VARCHAR(20) NOT NULL, created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS observation_revisions (
        id VARCHAR(64) PRIMARY KEY, observation_id VARCHAR(64) NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, prior_json TEXT NOT NULL, new_json TEXT NOT NULL, actor VARCHAR(255) NOT NULL,
        reason VARCHAR(500) NOT NULL, created_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS case_snapshots (
        id VARCHAR(64) PRIMARY KEY, patient_id VARCHAR(255) NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        document_id VARCHAR(64) NOT NULL REFERENCES documents(id) ON DELETE CASCADE, content_json TEXT NOT NULL,
        sha256 CHAR(64) NOT NULL, created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL, superseded_at BIGINT)`,
      `CREATE TABLE IF NOT EXISTS engine_runs (
        id VARCHAR(64) PRIMARY KEY, snapshot_id VARCHAR(64) NOT NULL REFERENCES case_snapshots(id) ON DELETE CASCADE,
        snapshot_sha256 CHAR(64) NOT NULL, engine VARCHAR(40) NOT NULL, engine_version VARCHAR(60) NOT NULL,
        input_sha256 CHAR(64) NOT NULL, output_json TEXT NOT NULL, output_sha256 CHAR(64) NOT NULL, status VARCHAR(20) NOT NULL,
        created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS reports (
        id VARCHAR(64) PRIMARY KEY, patient_id VARCHAR(255) NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        snapshot_id VARCHAR(64) NOT NULL REFERENCES case_snapshots(id) ON DELETE CASCADE,
        engine_run_id VARCHAR(64) NOT NULL REFERENCES engine_runs(id) ON DELETE CASCADE, lineage_id VARCHAR(64) NOT NULL,
        version INTEGER NOT NULL, status VARCHAR(20) NOT NULL, structured_json TEXT NOT NULL, structured_sha256 CHAR(64) NOT NULL,
        created_by VARCHAR(255) NOT NULL, reviewed_by VARCHAR(255), reviewed_at BIGINT, supersedes_id VARCHAR(64),
        created_at BIGINT NOT NULL, UNIQUE (lineage_id, version))`,
    ];
    docTables.push(
      // Reference knowledge (plan §10) — SEPARATE from patient data: no patient columns.
      `CREATE TABLE IF NOT EXISTS reference_documents (
        id VARCHAR(64) PRIMARY KEY, tenant_id VARCHAR(255), title VARCHAR(300) NOT NULL, publisher VARCHAR(200) NOT NULL,
        source_url VARCHAR(1000) NOT NULL, license VARCHAR(200) NOT NULL, version VARCHAR(100) NOT NULL, scope VARCHAR(500) NOT NULL,
        status VARCHAR(20) NOT NULL CHECK (status IN ('draft','approved','retired')), approved_by VARCHAR(255), approved_at BIGINT,
        created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS reference_chunks (
        id VARCHAR(64) PRIMARY KEY, document_id VARCHAR(64) NOT NULL REFERENCES reference_documents(id) ON DELETE CASCADE,
        anchor VARCHAR(300) NOT NULL, text TEXT NOT NULL, content_sha256 CHAR(64) NOT NULL,
        embedding DOUBLE PRECISION[], embedding_model VARCHAR(120), dims INTEGER, indexed_at BIGINT)`,
      `CREATE TABLE IF NOT EXISTS model_reviews (
        id VARCHAR(64) PRIMARY KEY, snapshot_id VARCHAR(64) NOT NULL REFERENCES case_snapshots(id) ON DELETE CASCADE,
        engine_run_id VARCHAR(64) NOT NULL REFERENCES engine_runs(id) ON DELETE CASCADE, engine_output_sha256 CHAR(64) NOT NULL,
        status VARCHAR(30) NOT NULL, decision_model VARCHAR(120), review_model VARCHAR(120), reasoning_json TEXT,
        checks_json TEXT, review_json TEXT, problems_json TEXT NOT NULL, created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL)`,
    );
    docTables.push(
      // Licensed-clinician provisioning (separation of duties; audited).
      `CREATE TABLE IF NOT EXISTS clinician_credentials (
        user_id VARCHAR(255) PRIMARY KEY REFERENCES dash_users(id) ON DELETE CASCADE,
        license_number VARCHAR(100) NOT NULL, jurisdiction VARCHAR(100) NOT NULL, licensing_body VARCHAR(200) NOT NULL,
        verification_note VARCHAR(500) NOT NULL, status VARCHAR(20) NOT NULL CHECK (status IN ('active','revoked')),
        provisioned_by VARCHAR(255) NOT NULL, provisioned_at BIGINT NOT NULL, revoked_by VARCHAR(255), revoked_at BIGINT)`,
    );
    docTables.push(
      // PosturePulse integration (plan §9.1): explicit subject↔patient links (never by name).
      `CREATE TABLE IF NOT EXISTS posture_subject_links (
        id VARCHAR(64) PRIMARY KEY, patient_id VARCHAR(255) NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        subject_pseudo_id VARCHAR(200) NOT NULL, consent_record_id VARCHAR(200) NOT NULL, purpose VARCHAR(300) NOT NULL,
        linked_by VARCHAR(255) NOT NULL, linked_at BIGINT NOT NULL, revoked_at BIGINT, UNIQUE (patient_id, subject_pseudo_id))`,
      `CREATE TABLE IF NOT EXISTS posture_reports (
        id VARCHAR(64) PRIMARY KEY, patient_id VARCHAR(255) NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        link_id VARCHAR(64) NOT NULL REFERENCES posture_subject_links(id), session_id VARCHAR(200) NOT NULL,
        report_id VARCHAR(200) NOT NULL, report_version INTEGER NOT NULL, sign_off_json TEXT NOT NULL, provenance_json TEXT NOT NULL,
        not_measurable_json TEXT NOT NULL, symptoms_json TEXT NOT NULL, symptom_escalation BOOLEAN NOT NULL,
        content_sha256 CHAR(64) NOT NULL, imported_by VARCHAR(255) NOT NULL, imported_at BIGINT NOT NULL,
        verification VARCHAR(30) NOT NULL DEFAULT 'unverified_payload', upstream_origin VARCHAR(300), report_json TEXT,
        digest_status VARCHAR(40), view_sha256 CHAR(64),
        UNIQUE (report_id, report_version, verification))`,
      `CREATE TABLE IF NOT EXISTS posture_measurements (
        id VARCHAR(64) PRIMARY KEY, posture_report_id VARCHAR(64) NOT NULL REFERENCES posture_reports(id) ON DELETE CASCADE,
        metric_key VARCHAR(200) NOT NULL, label VARCHAR(300) NOT NULL, module VARCHAR(30) NOT NULL, tier VARCHAR(30) NOT NULL,
        unit VARCHAR(40) NOT NULL, side VARCHAR(20), value DOUBLE PRECISION, uncertainty DOUBLE PRECISION,
        unsupported_reasons_json TEXT NOT NULL, reference_json TEXT, excluded BOOLEAN NOT NULL, limitation_note TEXT NOT NULL,
        position VARCHAR(30), analysis_text TEXT, exclusion_reason VARCHAR(500), row_json TEXT)`,
    );
    docTables.push(
      // Research workspaces (plan §9/§9.3, phase 7): governed datasets + reproducible runs.
      `CREATE TABLE IF NOT EXISTS research_datasets (
        id VARCHAR(64) PRIMARY KEY, owner_id VARCHAR(255) NOT NULL, name VARCHAR(200) NOT NULL, purpose VARCHAR(500) NOT NULL,
        content_sha256 CHAR(64) NOT NULL, byte_size INTEGER NOT NULL, n_rows INTEGER NOT NULL, columns_json TEXT NOT NULL,
        dictionary_json TEXT NOT NULL, attestation_text VARCHAR(1000) NOT NULL, csv_text TEXT NOT NULL, created_at BIGINT NOT NULL,
        UNIQUE (owner_id, content_sha256))`,
      `CREATE TABLE IF NOT EXISTS research_runs (
        id VARCHAR(64) PRIMARY KEY, dataset_id VARCHAR(64) NOT NULL REFERENCES research_datasets(id) ON DELETE CASCADE,
        owner_id VARCHAR(255) NOT NULL, analysis VARCHAR(40) NOT NULL, params_json TEXT NOT NULL, plan_json TEXT, plan_sha256 CHAR(64),
        engine_version VARCHAR(60) NOT NULL, min_cell INTEGER NOT NULL, input_sha256 CHAR(64) NOT NULL, output_json TEXT, output_sha256 CHAR(64),
        status VARCHAR(30) NOT NULL, error_code VARCHAR(60), rerun_of VARCHAR(64), reproduced BOOLEAN, created_at BIGINT NOT NULL)`,
    );
    docTables.push(
      // Public scientific data (research-only). Source rows are IMMUTABLE: new content = new row (version); attachments pin a source id.
      `CREATE TABLE IF NOT EXISTS sci_sources (
        id VARCHAR(64) PRIMARY KEY, provider VARCHAR(30) NOT NULL, accession VARCHAR(80) NOT NULL, kind VARCHAR(30) NOT NULL, classification VARCHAR(30) NOT NULL,
        classification_note TEXT NOT NULL, format VARCHAR(30) NOT NULL, source_url TEXT NOT NULL, final_url TEXT NOT NULL, source_version VARCHAR(200) NOT NULL,
        retrieved_at BIGINT NOT NULL, sha256 CHAR(64) NOT NULL, bytes BIGINT NOT NULL, license TEXT NOT NULL, attribution TEXT NOT NULL, terms_url TEXT NOT NULL,
        restrictions TEXT NOT NULL, content_type VARCHAR(120), etag VARCHAR(200), parent_source_id VARCHAR(64), member_path VARCHAR(300) NOT NULL DEFAULT '',
        record_terms TEXT NOT NULL DEFAULT '', acquisition VARCHAR(30) NOT NULL DEFAULT 'live', replay_note TEXT,
        UNIQUE (provider, accession, kind, format, sha256, member_path))`,
      `CREATE TABLE IF NOT EXISTS sci_derived (
        id VARCHAR(64) PRIMARY KEY, source_id VARCHAR(64) NOT NULL REFERENCES sci_sources(id), parser VARCHAR(40) NOT NULL, parser_version VARCHAR(60) NOT NULL,
        status VARCHAR(20) NOT NULL, summary_json TEXT NOT NULL, created_at BIGINT NOT NULL, UNIQUE (source_id, parser, parser_version))`,
      // Which scopes (user:<id> / tenant:<id>) have retrieved/seen which public source. A source is visible only to scopes listed here.
      `CREATE TABLE IF NOT EXISTS sci_retrievals (
        scope_kind VARCHAR(10) NOT NULL, scope_id VARCHAR(255) NOT NULL, source_id VARCHAR(64) NOT NULL REFERENCES sci_sources(id), at BIGINT NOT NULL,
        PRIMARY KEY (scope_kind, scope_id, source_id))`,
      `CREATE TABLE IF NOT EXISTS sci_workspaces (
        id VARCHAR(64) PRIMARY KEY, scope_kind VARCHAR(10) NOT NULL, scope_id VARCHAR(255) NOT NULL, name VARCHAR(200) NOT NULL, purpose VARCHAR(500) NOT NULL, created_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS sci_items (
        id VARCHAR(64) PRIMARY KEY, workspace_id VARCHAR(64) NOT NULL REFERENCES sci_workspaces(id) ON DELETE CASCADE, source_id VARCHAR(64) NOT NULL REFERENCES sci_sources(id),
        label VARCHAR(200) NOT NULL, attached_by VARCHAR(255) NOT NULL, attached_at BIGINT NOT NULL, UNIQUE (workspace_id, source_id))`,
      `CREATE TABLE IF NOT EXISTS sci_searches (
        id VARCHAR(64) PRIMARY KEY, scope_kind VARCHAR(10) NOT NULL, scope_id VARCHAR(255) NOT NULL, provider VARCHAR(30) NOT NULL, query VARCHAR(300) NOT NULL, at BIGINT NOT NULL, result_count INTEGER NOT NULL)`,
    );
    docTables.push(
      // OCR study-policy records: IMMUTABLE versions (triggers), hash-chained per policy id. State can only be 'draft' — there is deliberately NO 'active' value in this build.
      `CREATE TABLE IF NOT EXISTS ocr_policies (
        policy_id VARCHAR(100) NOT NULL, version INTEGER NOT NULL, workspace_id VARCHAR(64) NOT NULL, kind VARCHAR(20) NOT NULL CHECK (kind IN ('synthetic_test','real_study')),
        state VARCHAR(10) NOT NULL CHECK (state IN ('draft')), content_json TEXT NOT NULL, sha256 CHAR(64) NOT NULL, prev_sha256 CHAR(64), created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (policy_id, version))`,
      `CREATE OR REPLACE FUNCTION ocr_policy_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'ocr policy versions are immutable (% on %)', TG_OP, TG_TABLE_NAME; END; $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS ocr_policies_immutable ON ocr_policies`, `CREATE TRIGGER ocr_policies_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ocr_policies FOR EACH STATEMENT EXECUTE FUNCTION ocr_policy_immutable()`,
    );
    docTables.push(
      // Draft-policy REVIEW records (two-person). Immutable. A decision is metadata + EXTERNAL references (recorded, never verified); it can never make a policy active or approved.
      `CREATE TABLE IF NOT EXISTS ocr_policy_review_submissions (
        id VARCHAR(64) PRIMARY KEY, workspace_id VARCHAR(64) NOT NULL, policy_id VARCHAR(100) NOT NULL, version INTEGER NOT NULL, policy_sha256 CHAR(64) NOT NULL,
        submitted_by VARCHAR(255) NOT NULL, submitted_at BIGINT NOT NULL, note_sha256 CHAR(64) NOT NULL, note_length INTEGER NOT NULL, UNIQUE (policy_id, version))`,
      `CREATE TABLE IF NOT EXISTS ocr_policy_review_decisions (
        id VARCHAR(64) PRIMARY KEY, submission_id VARCHAR(64) NOT NULL UNIQUE REFERENCES ocr_policy_review_submissions(id), reviewer_id VARCHAR(255) NOT NULL,
        decision VARCHAR(20) NOT NULL CHECK (decision IN ('reviewed','changes_requested')), decided_at BIGINT NOT NULL, policy_sha256 CHAR(64) NOT NULL,
        external_decision_ref VARCHAR(300), external_signature_ref VARCHAR(300), note_sha256 CHAR(64) NOT NULL, note_length INTEGER NOT NULL)`,
      `CREATE OR REPLACE FUNCTION ocr_policy_review_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'ocr policy review records are immutable (% on %)', TG_OP, TG_TABLE_NAME; END; $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS ocr_policy_subs_immutable ON ocr_policy_review_submissions`, `CREATE TRIGGER ocr_policy_subs_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ocr_policy_review_submissions FOR EACH STATEMENT EXECUTE FUNCTION ocr_policy_review_immutable()`,
      `DROP TRIGGER IF EXISTS ocr_policy_decs_immutable ON ocr_policy_review_decisions`, `CREATE TRIGGER ocr_policy_decs_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ocr_policy_review_decisions FOR EACH STATEMENT EXECUTE FUNCTION ocr_policy_review_immutable()`,
    );
    docTables.push(
      // AIKosh data registry (local governance). Inventory rows and approval records are IMMUTABLE (triggers below); decisions are append-only.
      `CREATE TABLE IF NOT EXISTS aikosh_files (
        path VARCHAR(300) NOT NULL, sha256 CHAR(64) NOT NULL, size_bytes BIGINT NOT NULL, format VARCHAR(20) NOT NULL, row_count BIGINT, inventory_json TEXT NOT NULL, registered_at BIGINT NOT NULL, registered_by VARCHAR(255) NOT NULL, PRIMARY KEY (path, sha256))`,
      `CREATE TABLE IF NOT EXISTS aikosh_approval_records (
        id VARCHAR(64) PRIMARY KEY, path VARCHAR(300) NOT NULL, sha256 CHAR(64) NOT NULL, recorded_by VARCHAR(255) NOT NULL, recorded_at BIGINT NOT NULL, content_json TEXT NOT NULL, content_sha256 CHAR(64) NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS aikosh_approval_decisions (
        id VARCHAR(64) PRIMARY KEY, record_id VARCHAR(64) NOT NULL REFERENCES aikosh_approval_records(id), decision VARCHAR(10) NOT NULL CHECK (decision IN ('approve','revoke')), decided_by VARCHAR(255) NOT NULL, decided_at BIGINT NOT NULL, reason_sha256 CHAR(64) NOT NULL, reason_length INTEGER NOT NULL, prev_hash CHAR(64) NOT NULL, hash CHAR(64) NOT NULL)`,
      `CREATE OR REPLACE FUNCTION aikosh_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'aikosh governance rows are immutable (% on %)', TG_OP, TG_TABLE_NAME; END; $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS aikosh_files_immutable ON aikosh_files`, `CREATE TRIGGER aikosh_files_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON aikosh_files FOR EACH STATEMENT EXECUTE FUNCTION aikosh_immutable()`,
      `DROP TRIGGER IF EXISTS aikosh_records_immutable ON aikosh_approval_records`, `CREATE TRIGGER aikosh_records_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON aikosh_approval_records FOR EACH STATEMENT EXECUTE FUNCTION aikosh_immutable()`,
      `DROP TRIGGER IF EXISTS aikosh_decisions_immutable ON aikosh_approval_decisions`, `CREATE TRIGGER aikosh_decisions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON aikosh_approval_decisions FOR EACH STATEMENT EXECUTE FUNCTION aikosh_immutable()`,
    );
    docTables.push(
      // OCR validation-study workspaces (study tooling only; synthetic data). Membership here is AUTHORITATIVE: nothing is read from request bodies.
      `CREATE TABLE IF NOT EXISTS ocr_study_workspaces (
        id VARCHAR(64) PRIMARY KEY, tenant_id VARCHAR(255) NOT NULL, name VARCHAR(200) NOT NULL, purpose VARCHAR(500) NOT NULL, created_by VARCHAR(255) NOT NULL,
        created_at BIGINT NOT NULL, severity_map_json TEXT NOT NULL DEFAULT '{}', severity_set_by VARCHAR(255), severity_set_at BIGINT)`,
      `CREATE TABLE IF NOT EXISTS ocr_study_members (
        workspace_id VARCHAR(64) NOT NULL REFERENCES ocr_study_workspaces(id) ON DELETE CASCADE, user_id VARCHAR(255) NOT NULL,
        study_role VARCHAR(30) NOT NULL CHECK (study_role IN ('study_owner','dataset_custodian','annotator','adjudicator','statistician','clinical_lead','auditor')),
        added_by VARCHAR(255) NOT NULL, added_at BIGINT NOT NULL, PRIMARY KEY (workspace_id, user_id))`,
      // Membership lifecycle: rows are never deleted (annotation/adjudication/audit provenance stays attributable). status gates ALL access immediately.
      `ALTER TABLE ocr_study_members ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT 'active'`,
      `ALTER TABLE ocr_study_members ADD COLUMN IF NOT EXISTS status_reason_sha256 CHAR(64)`,
      `ALTER TABLE ocr_study_members ADD COLUMN IF NOT EXISTS status_reason_length INTEGER`,
      `ALTER TABLE ocr_study_members ADD COLUMN IF NOT EXISTS status_changed_by VARCHAR(255)`,
      `ALTER TABLE ocr_study_members ADD COLUMN IF NOT EXISTS status_changed_at BIGINT`,
      // Two-person control for suspending/removing a dataset custodian or clinical lead. Reasons are stored as hash + length only.
      `CREATE TABLE IF NOT EXISTS ocr_study_member_actions (
        id VARCHAR(64) PRIMARY KEY, workspace_id VARCHAR(64) NOT NULL REFERENCES ocr_study_workspaces(id) ON DELETE CASCADE, target_user_id VARCHAR(255) NOT NULL,
        action VARCHAR(10) NOT NULL CHECK (action IN ('suspend','remove')), requested_by VARCHAR(255) NOT NULL, requested_at BIGINT NOT NULL, reason_sha256 CHAR(64) NOT NULL, reason_length INTEGER NOT NULL,
        status VARCHAR(12) NOT NULL CHECK (status IN ('requested','approved','executed','cancelled')), approved_by VARCHAR(255), approved_at BIGINT, approval_reason_sha256 CHAR(64), executed_at BIGINT)`,
      `CREATE TABLE IF NOT EXISTS ocr_study_datasets (
        workspace_id VARCHAR(64) NOT NULL REFERENCES ocr_study_workspaces(id) ON DELETE CASCADE, dataset_id VARCHAR(64) NOT NULL, name VARCHAR(200) NOT NULL,
        split VARCHAR(30) NOT NULL, provenance_kind VARCHAR(30) NOT NULL, annotator_a VARCHAR(255) NOT NULL, annotator_b VARCHAR(255) NOT NULL,
        registered_by VARCHAR(255) NOT NULL, registered_at BIGINT NOT NULL, PRIMARY KEY (workspace_id, dataset_id))`,
      // Policy binding recorded when a dataset is LOCKED (the version in force at the lock; later policy edits cannot change it).
      `ALTER TABLE ocr_study_datasets ADD COLUMN IF NOT EXISTS policy_id VARCHAR(100)`, `ALTER TABLE ocr_study_datasets ADD COLUMN IF NOT EXISTS policy_version INTEGER`, `ALTER TABLE ocr_study_datasets ADD COLUMN IF NOT EXISTS policy_sha256 CHAR(64)`,
      // One-time unlock authorizations: bound to workspace, tenant, dataset, manifest hash and lock digest; the requester and authorizer are authenticated users.
      `CREATE TABLE IF NOT EXISTS ocr_study_unlocks (
        id VARCHAR(64) PRIMARY KEY, workspace_id VARCHAR(64) NOT NULL REFERENCES ocr_study_workspaces(id) ON DELETE CASCADE, tenant_id VARCHAR(255) NOT NULL, dataset_id VARCHAR(64) NOT NULL,
        requested_by VARCHAR(255) NOT NULL, requested_at BIGINT NOT NULL, request_reason TEXT NOT NULL, manifest_sha256 CHAR(64) NOT NULL, lock_digest CHAR(64) NOT NULL,
        status VARCHAR(20) NOT NULL CHECK (status IN ('requested','authorized','executed')), authorized_by VARCHAR(255), authorizer_role_claim VARCHAR(100),
        authorizer_credential_ref VARCHAR(200), protocol_deviation_ref VARCHAR(200), authorization_reason TEXT, authorized_at BIGINT, authorization_sha256 CHAR(64) UNIQUE,
        authorized_manifest_sha256 CHAR(64), executed_at BIGINT)`,
    );
    docTables.push(
      // Physiological monitoring (plan §9.2). Alerts are SIMULATION-ONLY: enforced by a CHECK constraint.
      `CREATE TABLE IF NOT EXISTS monitoring_devices (
        id VARCHAR(64) PRIMARY KEY, patient_id VARCHAR(255) NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        kind VARCHAR(30) NOT NULL CHECK (kind IN ('simulator','fhir_gateway','manual_entry')), label VARCHAR(200) NOT NULL,
        simulation BOOLEAN NOT NULL, purpose VARCHAR(500) NOT NULL, paired_by VARCHAR(255) NOT NULL, paired_at BIGINT NOT NULL, unpaired_at BIGINT,
        CHECK ((kind = 'simulator') = simulation))`,
      `CREATE TABLE IF NOT EXISTS monitoring_observations (
        id VARCHAR(64) PRIMARY KEY, device_id VARCHAR(64) NOT NULL REFERENCES monitoring_devices(id) ON DELETE CASCADE,
        patient_id VARCHAR(255) NOT NULL, metric VARCHAR(30) NOT NULL, value DOUBLE PRECISION NOT NULL, unit VARCHAR(20) NOT NULL,
        source_time BIGINT NOT NULL, received_time BIGINT NOT NULL, sequence INTEGER, flags_json TEXT NOT NULL, limitation TEXT,
        original_json TEXT, simulation BOOLEAN NOT NULL, UNIQUE (device_id, metric, source_time))`,
      `CREATE INDEX IF NOT EXISTS idx_mon_obs_device ON monitoring_observations(device_id, metric, source_time)`,
      `CREATE TABLE IF NOT EXISTS monitoring_ingest_log (
        id VARCHAR(64) PRIMARY KEY, device_id VARCHAR(64) NOT NULL REFERENCES monitoring_devices(id) ON DELETE CASCADE,
        received_at BIGINT NOT NULL, accepted INTEGER NOT NULL, duplicates INTEGER NOT NULL, rejected_json TEXT NOT NULL, adapter_problems_json TEXT NOT NULL, by_user VARCHAR(255) NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS monitoring_alerts (
        id VARCHAR(64) PRIMARY KEY, device_id VARCHAR(64) NOT NULL REFERENCES monitoring_devices(id) ON DELETE CASCADE,
        state VARCHAR(20) NOT NULL, record_json TEXT NOT NULL, simulation BOOLEAN NOT NULL CHECK (simulation = TRUE), opened_at BIGINT NOT NULL)`,
    );
    docTables.push(
      // Model spend ledger: durable reservations, settled with PROVIDER-REPORTED cost (never an estimate); unknown stays unknown.
      `CREATE TABLE IF NOT EXISTS model_spend_ledger (
        id VARCHAR(64) PRIMARY KEY, scope_kind VARCHAR(10) NOT NULL CHECK (scope_kind IN ('user','tenant','system')), scope_id VARCHAR(255) NOT NULL,
        period CHAR(10) NOT NULL, role VARCHAR(20) NOT NULL, model VARCHAR(120) NOT NULL, returned_model VARCHAR(120), data_class VARCHAR(20) NOT NULL,
        state VARCHAR(16) NOT NULL CHECK (state IN ('reserved','settled','unknown_cost','released')),
        reserved_usd NUMERIC(14,8) NOT NULL CHECK (reserved_usd >= 0), actual_usd NUMERIC(14,8) CHECK (actual_usd IS NULL OR actual_usd >= 0),
        cost_note VARCHAR(40), attempts INTEGER NOT NULL DEFAULT 0, status VARCHAR(30),
        prompt_tokens INTEGER, completion_tokens INTEGER, reasoning_tokens INTEGER, created_at BIGINT NOT NULL, settled_at BIGINT)`,
      `CREATE INDEX IF NOT EXISTS idx_spend_period_scope ON model_spend_ledger(period, scope_kind, scope_id, state)`,
    );
    docTables.push(
      // Research Studio (M1): durable projects + task graph. Brief revisions are append-only evidence of what the researcher
      // actually asked for; task events are an append-only, hash-chained log (triggers refuse update/delete/truncate) —
      // the evidence trail required by the brief ("retain evidence of that work").
      `CREATE TABLE IF NOT EXISTS research_studio_projects (
        id VARCHAR(64) PRIMARY KEY, owner_id VARCHAR(255) NOT NULL,
        mode VARCHAR(30) NOT NULL CHECK (mode IN ('narrative_review','systematic_review','scoping_review','original_research','research_protocol','case_report','dissertation')),
        title VARCHAR(200) NOT NULL, status VARCHAR(20) NOT NULL CHECK (status IN ('draft','active','archived')) DEFAULT 'draft',
        brief_json TEXT NOT NULL, brief_sha256 CHAR(64) NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_projects_owner ON research_studio_projects(owner_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS research_studio_project_revisions (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        brief_json TEXT NOT NULL, brief_sha256 CHAR(64) NOT NULL, created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL)`,
      `CREATE OR REPLACE FUNCTION research_studio_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'research studio evidence rows are immutable (% on %)', TG_OP, TG_TABLE_NAME; END; $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS rs_revisions_immutable ON research_studio_project_revisions`,
      `CREATE TRIGGER rs_revisions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON research_studio_project_revisions FOR EACH STATEMENT EXECUTE FUNCTION research_studio_immutable()`,
      `CREATE TABLE IF NOT EXISTS research_studio_tasks (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        type VARCHAR(80) NOT NULL,
        status VARCHAR(20) NOT NULL CHECK (status IN ('queued','running','awaiting_user','paused','retryable_failure','failed','cancelled','completed')),
        depends_on_json TEXT NOT NULL DEFAULT '[]', params_json TEXT NOT NULL DEFAULT '{}', result_json TEXT, result_sha256 CHAR(64),
        attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, next_eligible_at BIGINT,
        claimed_at BIGINT, claim_token VARCHAR(64),
        invalidated_at BIGINT, invalidated_reason VARCHAR(300),
        budget_json TEXT NOT NULL DEFAULT '{}', usage_json TEXT NOT NULL DEFAULT '{"actions":0,"tokens":0}',
        revision_group VARCHAR(100), max_revisions_in_group INTEGER,
        created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
        ordinal BIGSERIAL)`,
      // Several tasks created within the same commit (e.g. a batch of childTasks) can share the same millisecond
      // created_at; ORDER BY created_at alone is then not guaranteed stable across repeated SELECTs (rows can reorder
      // between reads/page loads). `ordinal` is a true creation-order tiebreaker.
      `CREATE INDEX IF NOT EXISTS idx_rs_tasks_project ON research_studio_tasks(project_id, status, type)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_tasks_revision_group ON research_studio_tasks(project_id, revision_group)`,
      `CREATE TABLE IF NOT EXISTS research_studio_task_events (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL, task_id VARCHAR(64) NOT NULL, seq INTEGER NOT NULL,
        event VARCHAR(40) NOT NULL, detail_json TEXT NOT NULL, at BIGINT NOT NULL, prev_hash CHAR(64) NOT NULL, hash CHAR(64) NOT NULL,
        UNIQUE (project_id, seq))`,
      `CREATE INDEX IF NOT EXISTS idx_rs_events_project ON research_studio_task_events(project_id, seq)`,
      `DROP TRIGGER IF EXISTS rs_events_immutable ON research_studio_task_events`,
      `CREATE TRIGGER rs_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON research_studio_task_events FOR EACH STATEMENT EXECUTE FUNCTION research_studio_immutable()`,

      // ── Research Studio M2: evidence graph (plan §5) ──────────────────────────────────────────────────────────────
      // questions → search runs → sources → excerpts → claims → sections. Every status column below is intentionally
      // separate: resolving an identifier is not metadata verification; having full text is not claim support; a check
      // that was never run is 'unknown', never silently 'passed'. Every table carries `ordinal BIGSERIAL` because rows
      // created in the same commit can share a millisecond `created_at` (the M1 lesson — see RESEARCH-STUDIO-EVALUATION.md).
      `CREATE TABLE IF NOT EXISTS research_studio_search_strategies (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, databases_json TEXT NOT NULL DEFAULT '[]', queries_json TEXT NOT NULL DEFAULT '[]', filters_json TEXT NOT NULL DEFAULT '{}',
        created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL, ordinal BIGSERIAL, UNIQUE (project_id, version))`,
      `DROP TRIGGER IF EXISTS rs_strategies_immutable ON research_studio_search_strategies`,
      `CREATE TRIGGER rs_strategies_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON research_studio_search_strategies FOR EACH STATEMENT EXECUTE FUNCTION research_studio_immutable()`,
      `CREATE TABLE IF NOT EXISTS research_studio_search_runs (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        strategy_id VARCHAR(64), task_id VARCHAR(64),
        source VARCHAR(60) NOT NULL, query_json TEXT NOT NULL DEFAULT '{}', filters_json TEXT NOT NULL DEFAULT '{}', page INTEGER NOT NULL DEFAULT 1,
        status VARCHAR(20) NOT NULL CHECK (status IN ('running','completed','failed','partial')),
        result_count INTEGER NOT NULL DEFAULT 0, error VARCHAR(500), started_at BIGINT NOT NULL, completed_at BIGINT, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_search_runs_project ON research_studio_search_runs(project_id, ordinal)`,
      `CREATE TABLE IF NOT EXISTS research_studio_sources (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        doi VARCHAR(300), pmid VARCHAR(60), url VARCHAR(2000), normalized_id VARCHAR(500) NOT NULL,
        title VARCHAR(2000) NOT NULL, authors_json TEXT NOT NULL DEFAULT '[]', year INTEGER, venue VARCHAR(500), source_type VARCHAR(40) NOT NULL DEFAULT 'unknown',
        content_hash CHAR(64), metadata_json TEXT NOT NULL DEFAULT '{}',
        metadata_verification_status VARCHAR(20) NOT NULL DEFAULT 'unknown' CHECK (metadata_verification_status IN ('unknown','unverified','verified','mismatch')),
        fulltext_status VARCHAR(20) NOT NULL DEFAULT 'unknown' CHECK (fulltext_status IN ('unknown','unavailable','abstract_only','full_text')),
        correction_status VARCHAR(20) NOT NULL DEFAULT 'unknown' CHECK (correction_status IN ('unknown','none','corrected','retracted')),
        import_provenance_json TEXT NOT NULL DEFAULT '{}',
        created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_sources_project ON research_studio_sources(project_id, ordinal)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_sources_normalized ON research_studio_sources(project_id, normalized_id)`,
      `CREATE TABLE IF NOT EXISTS research_studio_source_versions (
        id VARCHAR(64) PRIMARY KEY, source_id VARCHAR(64) NOT NULL REFERENCES research_studio_sources(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, metadata_json TEXT NOT NULL, content_hash CHAR(64), retrieved_at BIGINT NOT NULL, retrieval_metadata_json TEXT NOT NULL DEFAULT '{}',
        ordinal BIGSERIAL, UNIQUE (source_id, version))`,
      `DROP TRIGGER IF EXISTS rs_source_versions_immutable ON research_studio_source_versions`,
      `CREATE TRIGGER rs_source_versions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON research_studio_source_versions FOR EACH STATEMENT EXECUTE FUNCTION research_studio_immutable()`,
      `CREATE TABLE IF NOT EXISTS research_studio_source_links (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        source_id_a VARCHAR(64) NOT NULL REFERENCES research_studio_sources(id) ON DELETE CASCADE, source_id_b VARCHAR(64) NOT NULL REFERENCES research_studio_sources(id) ON DELETE CASCADE,
        relation VARCHAR(20) NOT NULL CHECK (relation IN ('duplicate','preprint_of','correction_of','same_version','unrelated')),
        status VARCHAR(20) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','rejected')),
        decided_by VARCHAR(255), decided_at BIGINT, created_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_source_links_project ON research_studio_source_links(project_id, ordinal)`,
      `CREATE TABLE IF NOT EXISTS research_studio_artifacts (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        source_id VARCHAR(64) NOT NULL REFERENCES research_studio_sources(id) ON DELETE CASCADE,
        kind VARCHAR(10) NOT NULL CHECK (kind IN ('pdf','text')), storage_path VARCHAR(500) NOT NULL, sha256 CHAR(64) NOT NULL, size_bytes INTEGER NOT NULL,
        created_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_artifacts_source ON research_studio_artifacts(source_id)`,
      `CREATE TABLE IF NOT EXISTS research_studio_excerpts (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        source_id VARCHAR(64) NOT NULL REFERENCES research_studio_sources(id) ON DELETE CASCADE,
        task_id VARCHAR(64),
        locator_json TEXT NOT NULL DEFAULT '{}', text TEXT NOT NULL, sha256 CHAR(64) NOT NULL,
        extracted_by VARCHAR(20) NOT NULL CHECK (extracted_by IN ('human','deterministic','model')), created_by VARCHAR(255) NOT NULL,
        invalidated_at BIGINT, invalidated_reason VARCHAR(300),
        created_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_excerpts_project ON research_studio_excerpts(project_id, ordinal)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_excerpts_source ON research_studio_excerpts(source_id)`,
      `CREATE TABLE IF NOT EXISTS research_studio_claims (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        statement VARCHAR(2000) NOT NULL, created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_claims_project ON research_studio_claims(project_id, ordinal)`,
      `CREATE TABLE IF NOT EXISTS research_studio_claim_evidence_links (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        claim_id VARCHAR(64) NOT NULL REFERENCES research_studio_claims(id) ON DELETE CASCADE, excerpt_id VARCHAR(64) NOT NULL REFERENCES research_studio_excerpts(id) ON DELETE CASCADE,
        relation VARCHAR(20) NOT NULL CHECK (relation IN ('supports','contradicts','unclear')),
        claim_support_status VARCHAR(20) NOT NULL DEFAULT 'unknown' CHECK (claim_support_status IN ('unknown','unresolved','supported','contradicted')),
        created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_claim_links_claim ON research_studio_claim_evidence_links(claim_id, ordinal)`,
      `CREATE TABLE IF NOT EXISTS research_studio_screening_decisions (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        source_id VARCHAR(64) NOT NULL REFERENCES research_studio_sources(id) ON DELETE CASCADE,
        decision VARCHAR(10) NOT NULL CHECK (decision IN ('pending','include','exclude')), exclusion_reason VARCHAR(500),
        decided_by VARCHAR(255) NOT NULL, decided_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `DROP TRIGGER IF EXISTS rs_screening_immutable ON research_studio_screening_decisions`,
      `CREATE TRIGGER rs_screening_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON research_studio_screening_decisions FOR EACH STATEMENT EXECUTE FUNCTION research_studio_immutable()`,
      `CREATE INDEX IF NOT EXISTS idx_rs_screening_source ON research_studio_screening_decisions(source_id, ordinal)`,
      `CREATE TABLE IF NOT EXISTS research_studio_evidence_matrices (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        task_id VARCHAR(64) NOT NULL, matrix_json TEXT NOT NULL, built_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_matrices_project ON research_studio_evidence_matrices(project_id, ordinal)`,

      // ── Research Studio M3: browser research transport (plan §4) ─────────────────────────────────────────────────
      // Profile METADATA only — never a credential, cookie or token. The actual authenticated browser state lives in
      // an isolated, owner-only, mode-0700 on-disk Playwright user-data directory addressed by `user_data_dir`
      // (never committed, never logged verbatim). The session lock (`locked_by_task_id`/`locked_at`) is a per-profile
      // mutex using the exact same atomic-CAS pattern as task-store's claimNextReady, so only one task ever drives a
      // given profile at a time.
      `CREATE TABLE IF NOT EXISTS research_studio_browser_profiles (
        id VARCHAR(64) PRIMARY KEY, owner_id VARCHAR(255) NOT NULL, provider VARCHAR(60) NOT NULL, label VARCHAR(200) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connecting','active','expired','revoked')),
        user_data_dir VARCHAR(500) NOT NULL,
        locked_by_task_id VARCHAR(64), locked_at BIGINT,
        created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, last_used_at BIGINT, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_browser_profiles_owner ON research_studio_browser_profiles(owner_id, ordinal)`,

      // ── Research Studio M4: manuscript/thesis authoring (plan §3-4) ──────────────────────────────────────────────
      // Sections are append-only: every draft/revision/editorial proposal is a NEW row (never an edit in place);
      // `status` is the only mutable field (proposed → accepted/rejected). `section_key` + `version` gives the
      // append-only history; "current" content is the latest 'accepted' row per (project_id, section_key).
      `CREATE TABLE IF NOT EXISTS research_studio_sections (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        task_id VARCHAR(64), section_key VARCHAR(200) NOT NULL, version INTEGER NOT NULL,
        kind VARCHAR(10) NOT NULL CHECK (kind IN ('outline','section','chapter')),
        title VARCHAR(500) NOT NULL, content_text TEXT NOT NULL,
        content_source VARCHAR(20) NOT NULL CHECK (content_source IN ('human','deterministic_digest','editorial_proposal','model')),
        model_provenance_json TEXT NOT NULL DEFAULT '{}',
        status VARCHAR(10) NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted','proposed','rejected')),
        parent_version_id VARCHAR(64),
        invalidated_at BIGINT, invalidated_reason VARCHAR(300),
        created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL, ordinal BIGSERIAL,
        UNIQUE (project_id, section_key, version))`,
      // `status` reflects the value at CREATION time (accepted content is created 'accepted' directly; an editorial
      // proposal is created 'proposed'); whether a 'proposed' row was later accepted/rejected lives in
      // research_studio_author_decisions, not as a mutation of `status`. `invalidated_at`/`invalidated_reason` ARE
      // mutable (same convention as research_studio_excerpts) so downstream invalidation can flag stale content
      // without deleting or rewriting it.
      `CREATE INDEX IF NOT EXISTS idx_rs_sections_project ON research_studio_sections(project_id, section_key, ordinal)`,
      `CREATE TABLE IF NOT EXISTS research_studio_section_comments (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        section_id VARCHAR(64) NOT NULL REFERENCES research_studio_sections(id) ON DELETE CASCADE,
        body TEXT NOT NULL, created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_section_comments_section ON research_studio_section_comments(section_id, ordinal)`,
      `CREATE TABLE IF NOT EXISTS research_studio_author_decisions (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        section_id VARCHAR(64) NOT NULL REFERENCES research_studio_sections(id) ON DELETE CASCADE,
        decision VARCHAR(10) NOT NULL CHECK (decision IN ('accepted','rejected')), reason VARCHAR(500),
        decided_by VARCHAR(255) NOT NULL, decided_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `DROP TRIGGER IF EXISTS rs_author_decisions_immutable ON research_studio_author_decisions`,
      `CREATE TRIGGER rs_author_decisions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON research_studio_author_decisions FOR EACH STATEMENT EXECUTE FUNCTION research_studio_immutable()`,
      `CREATE TABLE IF NOT EXISTS research_studio_section_claims (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        section_id VARCHAR(64) NOT NULL REFERENCES research_studio_sections(id) ON DELETE CASCADE,
        claim_id VARCHAR(64) NOT NULL REFERENCES research_studio_claims(id) ON DELETE CASCADE,
        created_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_section_claims_section ON research_studio_section_claims(section_id)`,
      `CREATE TABLE IF NOT EXISTS research_studio_citation_audits (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        section_id VARCHAR(64) NOT NULL REFERENCES research_studio_sections(id) ON DELETE CASCADE, task_id VARCHAR(64) NOT NULL,
        findings_json TEXT NOT NULL, overall_status VARCHAR(20) NOT NULL CHECK (overall_status IN ('unknown','clean','issues_found')),
        created_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_citation_audits_section ON research_studio_citation_audits(section_id, ordinal)`,
      `CREATE TABLE IF NOT EXISTS research_studio_guidelines (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, journal_or_university VARCHAR(300) NOT NULL,
        constraints_json TEXT NOT NULL DEFAULT '{}', checklist_json TEXT NOT NULL DEFAULT '[]',
        created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL, ordinal BIGSERIAL, UNIQUE (project_id, version))`,
      `DROP TRIGGER IF EXISTS rs_guidelines_immutable ON research_studio_guidelines`,
      `CREATE TRIGGER rs_guidelines_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON research_studio_guidelines FOR EACH STATEMENT EXECUTE FUNCTION research_studio_immutable()`,
      `CREATE TABLE IF NOT EXISTS research_studio_compliance_reports (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        task_id VARCHAR(64) NOT NULL, report_json TEXT NOT NULL, built_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_compliance_project ON research_studio_compliance_reports(project_id, ordinal)`,

      // ── Research Studio M5: visuals and exports (plan §5/§8) ─────────────────────────────────────────────────────
      `CREATE TABLE IF NOT EXISTS research_studio_visuals (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        task_id VARCHAR(64), visual_key VARCHAR(200) NOT NULL, version INTEGER NOT NULL,
        type VARCHAR(30) NOT NULL CHECK (type IN ('flowchart','evidence_map','conceptual_diagram','prisma_flow','table','data_plot','graphical_abstract')),
        kind VARCHAR(20) NOT NULL CHECK (kind IN ('data_derived','conceptual')),
        title VARCHAR(300) NOT NULL, spec_json TEXT NOT NULL, data_provenance_json TEXT NOT NULL DEFAULT '{}', svg TEXT NOT NULL,
        invalidated_at BIGINT, invalidated_reason VARCHAR(300),
        created_by VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL, ordinal BIGSERIAL,
        UNIQUE (project_id, visual_key, version))`,
      `CREATE INDEX IF NOT EXISTS idx_rs_visuals_project ON research_studio_visuals(project_id, visual_key, ordinal)`,
      `CREATE TABLE IF NOT EXISTS research_studio_exports (
        id VARCHAR(64) PRIMARY KEY, project_id VARCHAR(64) NOT NULL REFERENCES research_studio_projects(id) ON DELETE CASCADE,
        task_id VARCHAR(64) NOT NULL,
        format VARCHAR(25) NOT NULL CHECK (format IN ('markdown','bibtex','ris','latex','pdf','docx','provenance_manifest')),
        content_sha256 CHAR(64) NOT NULL, byte_size INTEGER NOT NULL, storage_path VARCHAR(500) NOT NULL,
        manifest_json TEXT NOT NULL, built_at BIGINT NOT NULL, ordinal BIGSERIAL)`,
      `CREATE INDEX IF NOT EXISTS idx_rs_exports_project ON research_studio_exports(project_id, ordinal)`,
    );
    for (const ddl of docTables) await client.query(ddl);
    await client.query('CREATE INDEX IF NOT EXISTS idx_candidates_doc ON observation_candidates(document_id, status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_observations_doc ON observations(document_id)');

    // ── BaaS /v1: tenant-owned subjects + idempotency ────────────────────────
    // NULL tenant_id = dashboard-managed patient (patient_access grants apply);
    // non-NULL = owned by that API tenant (only that tenant can reach it).
    await client.query(`ALTER TABLE patients ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(255)`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_patients_tenant ON patients(tenant_id)');
    await client.query(`CREATE TABLE IF NOT EXISTS idempotency_keys (
      tenant_id VARCHAR(255) NOT NULL, key VARCHAR(200) NOT NULL, route VARCHAR(300) NOT NULL,
      status INTEGER NOT NULL, body_json TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (tenant_id, key))`);

    // ── Shared-store limits (F16): rate windows, run leases, monthly usage ───
    await client.query(`CREATE TABLE IF NOT EXISTS rate_counters (
      key VARCHAR(200) NOT NULL, window_start BIGINT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (key, window_start))`);
    await client.query(`CREATE TABLE IF NOT EXISTS run_leases (
      id VARCHAR(64) PRIMARY KEY, key VARCHAR(200) NOT NULL, expires_at BIGINT NOT NULL)`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_run_leases_key ON run_leases(key, expires_at)');
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS usage_month CHAR(7)`);

    // ── Tenant API keys: hashed at rest (compatible migration) ───────────────
    // Existing plaintext keys are hashed in place so they keep working; the
    // plaintext column is replaced by a non-secret placeholder (NOT NULL UNIQUE kept).
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS api_key_hash CHAR(64)`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS api_key_prefix VARCHAR(24)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_api_key_hash ON tenants(api_key_hash)`);
    await client.query(`
      UPDATE tenants
         SET api_key_hash = encode(sha256(convert_to(api_key, 'UTF8')), 'hex'),
             api_key_prefix = left(api_key, 14),
             api_key = 'hashed:' || tenant_id
       WHERE api_key_hash IS NULL AND api_key NOT LIKE 'hashed:%'`);

    // ── E-LAB platform tiering columns on tenants (additive, idempotent) ──────
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS scopes TEXT`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS baa_status VARCHAR(20) DEFAULT 'none'`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS residency VARCHAR(20) DEFAULT 'us'`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS allowed_clinical_domains TEXT`);

    // Indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, created_at)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_memory_facts_group ON memory_facts(group_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_traces_group ON agent_traces(group_id, created_at)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_toolcalls_ts ON tool_calls(ts)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_toolcalls_skill ON tool_calls(skill)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pid ON pipeline_runs(pipeline_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_patient_uid ON patients(uid)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_patient_analyses ON patient_analyses(patient_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_patients_risk ON patients(risk_score DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_usage_tenant ON api_usage_log(tenant_id, created_at)');

    // First administrator: NO built-in default accounts or passwords. Created
    // only from explicit ANUCLAW_BOOTSTRAP_ADMIN_* configuration while dash_users
    // is empty; otherwise nothing is created and initialisation continues.
    await bootstrapFirstAdmin(client, logger);

    await client.query('COMMIT');
    logger.info('PostgreSQL Database initialised & migrated successfully');
  } catch (err: any) {
    await client.query('ROLLBACK');
    logger.error('PostgreSQL Database migration failed:', err);
    throw err;
  } finally {
    client.release();
  }
}
