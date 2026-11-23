/**
 * Webhook outbox (interpretation engine, P3c). `enqueueWebhookEvent` runs INSIDE the transaction that changes the job,
 * so the notification exists if and only if the state change committed. The stored payload carries ids, hashes and
 * status only: no subject reference, no values, no identity. It is stored as the exact bytes that are sent, so every
 * retry re-sends identical content under the same event id (receivers can deduplicate on `Anukla-Event-Id`).
 */
import * as crypto from 'crypto';
import type { TxClient } from '../../db';

export type WebhookEventType = 'interpretation.completed' | 'interpretation.failed' | 'interpretation.report_ready' | 'interpretation.report_failed' | 'interpretation.report_rejected';

export interface EventData { jobId: string; skillId: string; status: 'completed' | 'failed'; findingsSha256?: string; errorCode?: string }

/** Returns the new event id, or null when the tenant has no enabled webhook (or the event already exists). */
export async function enqueueWebhookEvent(tx: TxClient, tenantId: string, type: WebhookEventType, data: EventData, now: number): Promise<string | null> {
  const wh = await tx.query('SELECT 1 FROM tenant_webhooks WHERE tenant_id = $1 AND enabled = TRUE', [tenantId]);
  if (!wh.rows.length) return null;
  const eventId = `evt_${crypto.randomBytes(12).toString('hex')}`;
  const body = {
    id: eventId, type, createdAt: new Date(now).toISOString(),
    data: {
      jobId: data.jobId, skillId: data.skillId, status: data.status,
      ...(data.findingsSha256 ? { findingsSha256: data.findingsSha256 } : {}),
      ...(data.errorCode ? { errorCode: data.errorCode } : {}),
      links: { self: `/v1/interpretations/${data.jobId}`, ...(data.status === 'completed' ? { findings: `/v1/interpretations/${data.jobId}/findings` } : {}) },
    },
  };
  const ins = await tx.query(
    `INSERT INTO webhook_deliveries (id, event_id, tenant_id, job_id, event_type, payload_json, status, run_after, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$7,$7) ON CONFLICT (job_id, event_type, dedupe_key) DO NOTHING RETURNING id`,
    [`dlv_${crypto.randomBytes(12).toString('hex')}`, eventId, tenantId, data.jobId, type, JSON.stringify(body), now]);
  return ins.rows.length ? eventId : null;
}

export interface ReportEventData { jobId: string; reportId: string; version: number; findingsSha256: string; reviewState: string | null; errorCode?: string }

/**
 * Report events: ids, hashes and the review state only; never report text or values. One event per job, type and report
 * (the outbox's unique index includes the report id), so a signed version notifies again.
 */
export async function enqueueReportEvent(tx: TxClient, tenantId: string, type: 'interpretation.report_ready' | 'interpretation.report_failed' | 'interpretation.report_rejected', data: ReportEventData, now: number): Promise<string | null> {
  const wh = await tx.query('SELECT 1 FROM tenant_webhooks WHERE tenant_id = $1 AND enabled = TRUE', [tenantId]);
  if (!wh.rows.length) return null;
  const eventId = `evt_${crypto.randomBytes(12).toString('hex')}`;
  const ready = type === 'interpretation.report_ready'; const rejected = type === 'interpretation.report_rejected';
  const body = {
    id: eventId, type, createdAt: new Date(now).toISOString(),
    data: {
      jobId: data.jobId, reportId: data.reportId, version: data.version, status: ready ? 'ready' : rejected ? 'rejected' : 'failed', findingsSha256: data.findingsSha256,
      ...(ready || rejected ? { reviewState: data.reviewState } : {}), ...(data.errorCode ? { errorCode: data.errorCode } : {}),
      links: { self: `/v1/interpretations/${data.jobId}`, ...(ready ? { report: `/v1/interpretations/${data.jobId}/report` } : {}) },
    },
  };
  const ins = await tx.query(
    `INSERT INTO webhook_deliveries (id, event_id, tenant_id, job_id, event_type, payload_json, status, run_after, created_at, updated_at, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$7,$7,$8) ON CONFLICT (job_id, event_type, dedupe_key) DO NOTHING RETURNING id`,
    [`dlv_${crypto.randomBytes(12).toString('hex')}`, eventId, tenantId, data.jobId, type, JSON.stringify(body), now, data.reportId]);
  return ins.rows.length ? eventId : null;
}
