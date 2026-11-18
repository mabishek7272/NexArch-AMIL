/**
 * Patient hub routes — access-controlled (see ../patient-access.ts).
 *
 * Every read/write requires role permission AND an explicit per-patient grant.
 * Model output is stored as a labelled DRAFT analysis; it never overwrites the
 * patient record (no model-derived risk scores, summaries or trial "matches").
 */
import { Router, Response } from 'express';
import { requireDashAuth, requireRole } from '../auth';
import { db } from '../../../db';
import { runAgent } from '../../../container-runner';
import { logger } from '../../../logger';
import { safeErrorSummary } from '../../../security/redact';
import { PatientAccessRequest, requirePatientAccess, roleAllows, AccessLevel, ROLE_MAX_LEVEL } from '../patient-access';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();
const SKILLS_DIR = path.resolve('./container/skills');

function parse(r: any) {
  if (!r) return r;
  const j = (v: string | null, d: string) => { try { return JSON.parse(v || d); } catch { return JSON.parse(d); } };
  return {
    ...r,
    conditions: j(r.conditions, '[]'),
    medications: j(r.medications, '[]'),
    genomic_profile: j(r.genomic_profile, '{}'),
    risk_factors: j(r.risk_factors, '[]'),
    trial_matches: j(r.trial_matches, '[]'),
  };
}

function fail(res: Response, where: string, err: unknown): void {
  logger.error(`patients route error (${where}): ${safeErrorSummary(err)}`);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error.' });
}

async function audit(actorId: string, action: string, patientId: string, meta: Record<string, unknown>, tx?: { query: (s: string, p?: any[]) => Promise<unknown> }): Promise<void> {
  const q = tx ?? { query: (s: string, p?: any[]) => db.query(s, p) };
  await q.query(
    `INSERT INTO audit_events (ts, action, actor_id, actor_type, channel, group_id, target_type, target_id, meta)
     VALUES ($1, $2, $3, 'dashboard_user', 'dashboard', NULL, 'patient', $4, $5)`,
    [Date.now(), action, actorId, patientId, JSON.stringify(meta)],
  );
}

// ── List: only patients this user holds a grant for ─────────────────────────────
router.get('/', requireDashAuth, async (req: PatientAccessRequest, res) => {
  if (!roleAllows(req.user!.role, 'read')) { res.status(403).json({ error: 'Your role does not permit patient access.' }); return; }
  const q = (req.query.q as string) ?? '';
  const risk = (req.query.risk as string) ?? '';
  const params: unknown[] = [req.user!.id];
  const where: string[] = ['pa.user_id = $1'];
  if (q) { params.push(`%${q}%`); where.push(`(p.name ILIKE $${params.length} OR p.uid ILIKE $${params.length})`); }
  if (risk) { params.push(risk); where.push(`p.risk_level = $${params.length}`); }
  try {
    const rows = await db.query(
      `SELECT p.*, pa.access_level FROM patients p
         JOIN patient_access pa ON pa.patient_id = p.id
        WHERE ${where.join(' AND ')}
        ORDER BY p.updated_at DESC`,
      params,
    );
    res.json({ patients: rows.map(parse), total: rows.length });
  } catch (err) { fail(res, 'list', err); }
});

// ── Admin: patients with NO grant (minimal fields only — no clinical data) ──────
router.get('/unassigned', requireDashAuth, requireRole('admin'), async (_req, res) => {
  try {
    const rows = await db.query(
      `SELECT p.id, p.uid, p.created_at FROM patients p
        WHERE NOT EXISTS (SELECT 1 FROM patient_access pa WHERE pa.patient_id = p.id)
        ORDER BY p.created_at ASC LIMIT 500`,
    );
    res.json({ unassigned: rows, note: 'These records are inaccessible until access is explicitly granted.' });
  } catch (err) { fail(res, 'unassigned', err); }
});

// ── Admin: grant/replace access (explicit, audited, purpose required) ──────────
router.post('/:id/access', requireDashAuth, requireRole('admin'), async (req: PatientAccessRequest, res) => {
  const { user_id, access_level, purpose } = req.body ?? {};
  if (typeof user_id !== 'string' || !['read', 'write', 'owner'].includes(access_level) || typeof purpose !== 'string' || purpose.trim().length < 3) {
    res.status(400).json({ error: 'user_id, access_level (read|write|owner) and a purpose are required.' });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const patient = await tx.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [String(req.params.id)]);
      if (!patient.rows[0]) return { status: 404, body: { error: 'Patient not found' } };
      const target = await tx.query<{ role: string }>('SELECT role FROM dash_users WHERE id = $1', [user_id]);
      if (!target.rows[0]) return { status: 400, body: { error: 'Unknown user.' } };
      if (!roleAllows(target.rows[0].role, access_level as AccessLevel)) {
        return { status: 400, body: { error: `Role '${target.rows[0].role}' cannot hold '${access_level}' access (max: ${ROLE_MAX_LEVEL[target.rows[0].role] ?? 'none'}).` } };
      }
      await tx.query(
        `INSERT INTO patient_access (patient_id, user_id, access_level, purpose, granted_by, granted_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (patient_id, user_id) DO UPDATE SET access_level = EXCLUDED.access_level,
           purpose = EXCLUDED.purpose, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at`,
        [String(req.params.id), user_id, access_level, purpose.trim(), req.user!.id, Date.now()],
      );
      await audit(req.user!.id, 'patient.access.grant', String(req.params.id), { user_id, access_level, purpose: purpose.trim() }, tx);
      return { status: 200, body: { ok: true } };
    });
    res.status(result.status).json(result.body);
  } catch (err) { fail(res, 'grant', err); }
});

// ── Admin: revoke access ───────────────────────────────────────────────────────
router.delete('/:id/access/:userId', requireDashAuth, requireRole('admin'), async (req: PatientAccessRequest, res) => {
  try {
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM patient_access WHERE patient_id = $1 AND user_id = $2', [String(req.params.id), String(req.params.userId)]);
      await audit(req.user!.id, 'patient.access.revoke', String(req.params.id), { user_id: String(req.params.userId) }, tx);
    });
    res.json({ ok: true });
  } catch (err) { fail(res, 'revoke', err); }
});

// ── Not implemented: previously claimed to queue background scoring but ran nothing ─
router.post('/bulk/risk-score', requireDashAuth, (_req, res) => {
  res.status(501).json({ error: 'Bulk risk scoring is not implemented. No validated risk model is available; nothing was queued.' });
});

// ── Detail ─────────────────────────────────────────────────────────────────────
router.get('/:id', requireDashAuth, requirePatientAccess('read'), async (req: PatientAccessRequest, res) => {
  try {
    const p = await db.queryOne('SELECT * FROM patients WHERE id = $1', [String(req.params.id)]);
    if (!p) { res.status(404).json({ error: 'Patient not found' }); return; }
    const analyses = await db.query('SELECT * FROM patient_analyses WHERE patient_id = $1 ORDER BY ts DESC LIMIT 20', [p.id]);
    res.json({ patient: parse(p), analyses, access_level: req.patientAccess });
  } catch (err) { fail(res, 'detail', err); }
});

// ── Create: creator becomes owner (atomic) ─────────────────────────────────────
router.post('/', requireDashAuth, async (req: PatientAccessRequest, res) => {
  if (!roleAllows(req.user!.role, 'owner')) { res.status(403).json({ error: 'Your role does not permit creating patients.' }); return; }
  const { name, dob, sex, uid, conditions, medications, genomic_profile, purpose } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) { res.status(400).json({ error: 'name is required' }); return; }
  const id = crypto.randomUUID();
  const now = Date.now();
  const recordUid = typeof uid === 'string' && uid.trim() ? uid.trim() : `ANU-${crypto.randomUUID()}`;
  try {
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO patients (id, uid, name, dob, sex, conditions, medications, genomic_profile, created_at, updated_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, recordUid, name.trim(), dob ?? null, sex ?? null,
          JSON.stringify(conditions ?? []), JSON.stringify(medications ?? []), JSON.stringify(genomic_profile ?? {}), now, now, req.user!.id],
      );
      await tx.query(
        `INSERT INTO patient_access (patient_id, user_id, access_level, purpose, granted_by, granted_at) VALUES ($1, $2, 'owner', $3, $2, $4)`,
        [id, req.user!.id, typeof purpose === 'string' && purpose.trim() ? purpose.trim() : 'record creator', now],
      );
      await audit(req.user!.id, 'patient.create', id, {}, tx);
    });
    res.status(201).json({ id, uid: recordUid });
  } catch (e: any) {
    if (e?.code === '23505') { res.status(409).json({ error: 'UID already exists' }); return; }
    fail(res, 'create', e);
  }
});

// ── Update (write) ─────────────────────────────────────────────────────────────
router.put('/:id', requireDashAuth, requirePatientAccess('write'), async (req: PatientAccessRequest, res) => {
  const { name, dob, sex, conditions, medications, genomic_profile, risk_score, risk_level, risk_factors } = req.body ?? {};
  try {
    await db.query(`
      UPDATE patients SET
        name=COALESCE($1,name), dob=COALESCE($2,dob), sex=COALESCE($3,sex),
        conditions=COALESCE($4,conditions), medications=COALESCE($5,medications),
        genomic_profile=COALESCE($6,genomic_profile), risk_score=COALESCE($7,risk_score),
        risk_level=COALESCE($8,risk_level), risk_factors=COALESCE($9,risk_factors), updated_at=$10
      WHERE id=$11
    `, [
      name ?? null, dob ?? null, sex ?? null,
      conditions ? JSON.stringify(conditions) : null,
      medications ? JSON.stringify(medications) : null,
      genomic_profile ? JSON.stringify(genomic_profile) : null,
      risk_score ?? null, risk_level ?? null,
      risk_factors ? JSON.stringify(risk_factors) : null,
      Date.now(), String(req.params.id),
    ]);
    await audit(req.user!.id, 'patient.update', String(req.params.id), { fields: Object.keys(req.body ?? {}) });
    res.json({ ok: true });
  } catch (err) { fail(res, 'update', err); }
});

// ── Delete (owner) ─────────────────────────────────────────────────────────────
router.delete('/:id', requireDashAuth, requirePatientAccess('owner'), async (req: PatientAccessRequest, res) => {
  try {
    await db.transaction(async (tx) => {
      await audit(req.user!.id, 'patient.delete', String(req.params.id), {}, tx);
      await tx.query('DELETE FROM patient_analyses WHERE patient_id = $1', [String(req.params.id)]);
      await tx.query('DELETE FROM patients WHERE id = $1', [String(req.params.id)]);
    });
    res.json({ ok: true });
  } catch (err) { fail(res, 'delete', err); }
});

// ── Draft AI analysis (write) — SSE ────────────────────────────────────────────
export const ANALYSIS_PROMPTS: Record<string, (ctx: string, q?: string) => string> = {
  risk_stratification: (c) => `List the risk factors that are DOCUMENTED in this record and what further information would be needed for a formal risk assessment. Do not produce numeric risk scores — no validated model is applied here.\n\n${c}`,
  trial_matching: (c) => `Describe eligibility considerations a clinician might check when looking for clinical trials for this patient. You cannot search trial registries here: do not name specific trials or NCT numbers.\n\n${c}`,
  drug_interactions: (c) => `Identify medication combinations in this record that a pharmacist should review, and state that a licensed interaction database must be consulted. Do not assert interactions as verified facts.\n\n${c}`,
  care_plan: (c) => `Draft questions and considerations for the treating clinician's care plan. Mark everything as a draft; do not prescribe.\n\n${c}`,
  second_opinion: (c, q) => `Offer points for the treating clinician to consider.\n\n${c}\n\nQuestion: ${q ?? 'General review'}`,
  general: (c, q) => `${c}\n\nQuestion: ${q ?? 'Summarise the documented information and note what is missing.'}`,
};

router.post('/:id/analyse', requireDashAuth, requirePatientAccess('write'), async (req: PatientAccessRequest, res) => {
  let patient: any;
  try {
    patient = await db.queryOne('SELECT * FROM patients WHERE id = $1', [String(req.params.id)]);
  } catch (err) { fail(res, 'analyse-load', err); return; }
  if (!patient) { res.status(404).json({ error: 'Patient not found' }); return; }

  const { skill = 'anuclaw-clinical-ai', prompt, analysis_type = 'general' } = req.body ?? {};
  const build = ANALYSIS_PROMPTS[analysis_type];
  if (!build) { res.status(400).json({ error: `unknown analysis_type; use one of ${Object.keys(ANALYSIS_PROMPTS).join(', ')}` }); return; }
  if (typeof skill !== 'string' || !/^[a-z0-9-]+$/.test(skill)) { res.status(400).json({ error: 'invalid skill' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const p = parse(patient);
  const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(', ') : 'not recorded');
  const patientContext = [
    `Patient: ${p.name}`,
    `Record ID: ${p.uid ?? 'not recorded'}`,
    `DOB: ${p.dob ?? 'not recorded'} | Sex: ${p.sex ?? 'not recorded'}`,
    `Conditions: ${list(p.conditions)}`,
    `Medications: ${list(p.medications)}`,
  ].join('\n');

  const finalPrompt = build(patientContext, typeof prompt === 'string' ? prompt : undefined);
  const skillPath = path.join(SKILLS_DIR, skill, 'SKILL.md');
  const skillMd = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, 'utf-8').slice(0, 6000) : '';
  const fullPrompt = skillMd ? `You are running the ${skill} skill.\n\n${skillMd}\n\n---\n\nTask:\n${finalPrompt}` : finalPrompt;
  const startTs = Date.now();
  send('start', { skill, analysis_type });

  try {
    const result = await runAgent({ groupId: `patient-${patient.id}-${analysis_type}`, channel: 'patient_hub', prompt: fullPrompt });
    if (result.error) {
      send('error', { message: 'Analysis could not be completed.', code: result.error, executionMode: result.executionMode });
      send('done', { success: false, latencyMs: Date.now() - startTs });
      return;
    }
    const analysisId = crypto.randomUUID();
    await db.query(
      `INSERT INTO patient_analyses (id, patient_id, skill, prompt, result, ts, created_by, execution_mode, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft_unreviewed')`,
      [analysisId, patient.id, skill, `${analysis_type}`, result.text, Date.now(), req.user!.id, result.executionMode],
    );
    send('output', {
      text: result.text, analysisId, status: 'draft_unreviewed', executionMode: result.executionMode,
      warnings: result.warnings, egress: result.egress, latencyMs: Date.now() - startTs,
    });
    send('done', { success: true, latencyMs: Date.now() - startTs });
  } catch (err) {
    logger.error(`patient analysis failed: ${safeErrorSummary(err)}`);
    send('error', { message: 'Analysis failed.' });
    send('done', { success: false });
  } finally {
    res.end();
  }
});

export default router;
