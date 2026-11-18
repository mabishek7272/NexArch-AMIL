/**
 * API EHR routes — REAL tenant-scoped persistence (plan F09).
 *
 * Previously every route asked the agent to "call" an EHR function and returned
 * its prose with HTTP 201, so in text-only mode a generated profile/UID could be
 * reported as a successful write. Now:
 *   - registration / records are transactional PostgreSQL writes; 201 only after commit;
 *   - every query is scoped to the authenticated tenant (other tenants' UIDs → 404);
 *   - /patients/search is registered BEFORE /patients/:uid (no shadowing);
 *   - FHIR export is a deterministic rendering of stored rows, labelled as
 *     unprofiled R4 JSON (not conformance-tested); HL7 v2 export is not implemented (501).
 * No model is involved in any EHR operation.
 */
import { Router, Response } from 'express';
import * as crypto from 'crypto';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { perTenantRateLimit, quotaCheck } from '../middleware/rate-limit';
import { usageMeter } from '../middleware/usage-meter';
import { db } from '../../db';
import { logger } from '../../logger';
import { safeErrorSummary } from '../../security/redact';

const router = Router();
const guards = [requireAuth, perTenantRateLimit, quotaCheck, usageMeter];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY = /^[A-Za-z]{2}$/;
const GENDERS = new Set(['male', 'female', 'other', 'unknown']);
const MAX_FIELD = 500;

const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
export function matchKey(first: string, last: string, dob: string, gender: string): string {
  return [norm(first), norm(last), dob, norm(gender)].join('|');
}

function validDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && d.getTime() <= Date.now();
}

function str(v: unknown, max = MAX_FIELD): string | null {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null;
}

function fail(res: Response, where: string, err: unknown): void {
  logger.error(`ehr route error (${where}): ${safeErrorSummary(err)}`);
  res.status(500).json({ error: 'EHR operation failed; nothing was confirmed.' });
}

function tenant(req: AuthRequest): string { return req.tenant!.tenant_id; }
const uidParam = (req: AuthRequest) => String(req.params.uid);

async function findPatient(tenantId: string, uid: string) {
  return db.queryOne<any>('SELECT * FROM ehr_patients WHERE tenant_id = $1 AND uid = $2', [tenantId, uid]);
}

function present(p: any) {
  let extra: unknown = {};
  try { extra = JSON.parse(p.extra_json || '{}'); } catch { /* keep {} */ }
  return {
    uid: p.uid, first_name: p.first_name, last_name: p.last_name, date_of_birth: p.date_of_birth,
    gender: p.gender, country_code: p.country_code, extra, created_at: p.created_at, updated_at: p.updated_at,
  };
}

// ── Register ───────────────────────────────────────────────────────────────────
router.post('/patients', ...guards, async (req: AuthRequest, res: Response) => {
  const b = req.body ?? {};
  const first = str(b.first_name), last = str(b.last_name), country = str(b.country_code, 2);
  const gender = typeof b.gender === 'string' ? norm(b.gender) : '';
  const problems: string[] = [];
  if (!first) problems.push('first_name');
  if (!last) problems.push('last_name');
  if (!validDate(b.date_of_birth)) problems.push('date_of_birth (YYYY-MM-DD, not in the future)');
  if (!GENDERS.has(gender)) problems.push(`gender (${[...GENDERS].join('|')})`);
  if (!country || !COUNTRY.test(country)) problems.push('country_code (ISO 3166-1 alpha-2)');
  if (problems.length) { res.status(400).json({ error: `Missing or invalid fields: ${problems.join(', ')}` }); return; }

  const known = new Set(['first_name', 'last_name', 'date_of_birth', 'gender', 'country_code']);
  const extra = Object.fromEntries(Object.entries(b).filter(([k]) => !known.has(k)));
  if (JSON.stringify(extra).length > 20_000) { res.status(413).json({ error: 'Additional fields too large.' }); return; }

  const key = matchKey(first!, last!, b.date_of_birth, gender);
  const uid = `ANU-${country!.toUpperCase()}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const now = Date.now();
  try {
    const out = await db.transaction(async (tx) => {
      // Serialise registrations for the same identity within a tenant.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${tenant(req)}|${key}`]);
      const dup = await tx.query<{ uid: string }>('SELECT uid FROM ehr_patients WHERE tenant_id = $1 AND match_key = $2 LIMIT 1', [tenant(req), key]);
      if (dup.rows[0]) return { duplicate: dup.rows[0].uid };
      await tx.query(
        `INSERT INTO ehr_patients (uid, tenant_id, first_name, last_name, date_of_birth, gender, country_code, match_key, extra_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [uid, tenant(req), first, last, b.date_of_birth, gender, country!.toUpperCase(), key, JSON.stringify(extra), now],
      );
      return { created: true };
    });
    if ('duplicate' in out) {
      res.status(409).json({ error: 'A patient with the same name, date of birth and gender already exists for this tenant.', uid: out.duplicate });
      return;
    }
    const row = await findPatient(tenant(req), uid);
    res.status(201).json({ patient: present(row), persisted: true });
  } catch (err) { fail(res, 'register', err); }
});

// ── Search (registered before /:uid) ──────────────────────────────────────────
router.get('/patients/search', ...guards, async (req: AuthRequest, res: Response) => {
  const { first_name, last_name, date_of_birth, gender } = req.query as Record<string, string>;
  if (!first_name || !last_name || !validDate(date_of_birth) || !gender) {
    res.status(400).json({ error: 'first_name, last_name, date_of_birth (YYYY-MM-DD) and gender are required query params.' });
    return;
  }
  try {
    const rows = await db.query('SELECT * FROM ehr_patients WHERE tenant_id = $1 AND match_key = $2 ORDER BY created_at',
      [tenant(req), matchKey(first_name, last_name, date_of_birth, gender)]);
    res.json({ matches: rows.map(present), match_rule: 'exact normalised first/last name + date of birth + gender, this tenant only' });
  } catch (err) { fail(res, 'search', err); }
});

// ── Lookup ─────────────────────────────────────────────────────────────────────
router.get('/patients/:uid', ...guards, async (req: AuthRequest, res: Response) => {
  try {
    const p = await findPatient(tenant(req), uidParam(req));
    if (!p) { res.status(404).json({ error: 'Patient not found.' }); return; }
    const records = await db.query('SELECT id, kind, payload_json, created_at FROM ehr_records WHERE tenant_id = $1 AND uid = $2 ORDER BY created_at',
      [tenant(req), p.uid]);
    res.json({ patient: present(p), records: records.map((r: any) => ({ id: r.id, kind: r.kind, data: JSON.parse(r.payload_json), created_at: r.created_at })) });
  } catch (err) { fail(res, 'lookup', err); }
});

// ── Record writes ──────────────────────────────────────────────────────────────
type Kind = 'diagnosis' | 'prescription' | 'lab_report';

function validateRecord(kind: Kind, b: any): { data?: Record<string, unknown>; error?: string } {
  const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => b?.[k] !== undefined).map((k) => [k, b[k]]));
  if (kind === 'diagnosis') {
    if (!str(b?.description)) return { error: 'description is required.' };
    return { data: pick(['icd10_code', 'snomed_code', 'description', 'severity', 'diagnosed_by', 'status', 'onset_date']) };
  }
  if (kind === 'prescription') {
    const missing = ['medication_name', 'dosage', 'frequency'].filter((k) => !str(b?.[k]));
    if (!validDate(b?.start_date)) missing.push('start_date (YYYY-MM-DD)');
    if (missing.length) return { error: `Missing or invalid fields: ${missing.join(', ')}` };
    return { data: pick(['medication_name', 'dosage', 'frequency', 'start_date', 'prescribed_by', 'route', 'indication']) };
  }
  // lab_report: preserve the value exactly as supplied (no unit conversion or interpretation).
  if (!str(b?.test_name) || b?.value === undefined || b?.value === null || b?.value === '') {
    return { error: 'test_name and value are required.' };
  }
  return { data: { ...pick(['test_name', 'value', 'unit', 'loinc_code', 'reference_range', 'flag', 'ordered_by', 'collected_at']), value: b.value } };
}

function recordRoute(path: string, kind: Kind) {
  router.post(`/patients/:uid/${path}`, ...guards, async (req: AuthRequest, res: Response) => {
    const v = validateRecord(kind, req.body);
    if (v.error) { res.status(400).json({ error: v.error }); return; }
    const id = crypto.randomUUID();
    try {
      const out = await db.transaction(async (tx) => {
        const p = await tx.query('SELECT uid FROM ehr_patients WHERE tenant_id = $1 AND uid = $2 FOR SHARE', [tenant(req), uidParam(req)]);
        if (!p.rows[0]) return false;
        await tx.query('INSERT INTO ehr_records (id, tenant_id, uid, kind, payload_json, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [id, tenant(req), uidParam(req), kind, JSON.stringify(v.data), Date.now()]);
        await tx.query('UPDATE ehr_patients SET updated_at = $1 WHERE uid = $2', [Date.now(), uidParam(req)]);
        return true;
      });
      if (!out) { res.status(404).json({ error: 'Patient not found.' }); return; }
      res.status(201).json({ id, uid: uidParam(req), kind, data: v.data, persisted: true });
    } catch (err) { fail(res, kind, err); }
  });
}
recordRoute('diagnoses', 'diagnosis');
recordRoute('prescriptions', 'prescription');
recordRoute('lab-reports', 'lab_report');

// ── Exports ────────────────────────────────────────────────────────────────────
router.post('/patients/:uid/hl7', ...guards, (_req: AuthRequest, res: Response) => {
  res.status(501).json({ error: 'HL7 v2 export is not implemented. Use /fhir for a JSON export of stored records.' });
});

export function toFhirBundle(p: any, records: Array<{ id: string; kind: Kind; data: any }>) {
  const ref = `Patient/${p.uid}`;
  const entries: any[] = [{
    resource: {
      resourceType: 'Patient', id: p.uid,
      identifier: [{ system: 'urn:anuclaw:ehr-uid', value: p.uid }],
      name: [{ family: p.last_name, given: [p.first_name] }],
      gender: p.gender, birthDate: p.date_of_birth,
      address: [{ country: p.country_code }],
    },
  }];
  for (const r of records) {
    const d = r.data;
    if (r.kind === 'diagnosis') {
      const coding = [
        ...(d.icd10_code ? [{ system: 'http://hl7.org/fhir/sid/icd-10', code: d.icd10_code }] : []),
        ...(d.snomed_code ? [{ system: 'http://snomed.info/sct', code: d.snomed_code }] : []),
      ];
      entries.push({ resource: { resourceType: 'Condition', id: r.id, subject: { reference: ref }, code: { coding, text: d.description } } });
    } else if (r.kind === 'prescription') {
      entries.push({ resource: {
        resourceType: 'MedicationStatement', id: r.id, status: 'recorded', subject: { reference: ref },
        medicationCodeableConcept: { text: d.medication_name },
        dosage: [{ text: [d.dosage, d.frequency, d.route].filter(Boolean).join(' ') }],
        effectivePeriod: { start: d.start_date },
      } });
    } else {
      const numeric = typeof d.value === 'number' || (typeof d.value === 'string' && /^-?\d+(\.\d+)?$/.test(d.value));
      entries.push({ resource: {
        resourceType: 'Observation', id: r.id, status: 'registered', subject: { reference: ref },
        code: { coding: d.loinc_code ? [{ system: 'http://loinc.org', code: d.loinc_code }] : [], text: d.test_name },
        ...(numeric && d.unit ? { valueQuantity: { value: Number(d.value), unit: d.unit } } : { valueString: String(d.value) + (d.unit ? ` ${d.unit}` : '') }),
        ...(d.reference_range ? { referenceRange: [{ text: String(d.reference_range) }] } : {}),
      } });
    }
  }
  return { resourceType: 'Bundle', type: 'collection', entry: entries };
}

router.post('/patients/:uid/fhir', ...guards, async (req: AuthRequest, res: Response) => {
  try {
    const p = await findPatient(tenant(req), uidParam(req));
    if (!p) { res.status(404).json({ error: 'Patient not found.' }); return; }
    const rows = await db.query('SELECT id, kind, payload_json FROM ehr_records WHERE tenant_id = $1 AND uid = $2 ORDER BY created_at', [tenant(req), p.uid]);
    const bundle = toFhirBundle(p, rows.map((r: any) => ({ id: r.id, kind: r.kind, data: JSON.parse(r.payload_json) })));
    res.json({
      bundle,
      conformance: 'Unprofiled FHIR R4-shaped JSON rendered from stored rows. Not validated against any implementation guide; status values are placeholders.',
    });
  } catch (err) { fail(res, 'fhir', err); }
});

export default router;
