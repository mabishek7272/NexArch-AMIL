/**
 * Source Verifier (M2, plan §3/§5), task type 'literature.verify_sources'. Entirely deterministic — a connector
 * lookup plus an explicit field comparison, never a model judgement. It sets THREE independent statuses per source,
 * and never collapses one into another:
 *  - metadata_verification_status: did Crossref's own record for the stated DOI match this source's title/year?
 *    A DOI that does not resolve at all is a verification FAILURE ('mismatch'), not silently 'unknown' — a
 *    fabricated or unresolvable identifier must be caught, not passed through. No DOI to check → 'unverified'.
 *  - correction_status: taken directly from Crossref's own `update-to` field — never guessed.
 *  - fulltext_status: left exactly as it was UNLESS a local artifact now exists for the source (→ 'full_text').
 *    This agent never asserts 'abstract_only' or 'unavailable' on a hunch; those are set only by an explicit,
 *    recorded human/agent action elsewhere (evidence-service.setFulltextStatus) — "an unavailable check must
 *    remain unknown" (plan §5) is taken literally.
 */
import { AgentHandler } from '../types';
import { registerAgent } from '../agent-registry';
import { recordUsage } from '../task-store';
import { db } from '../../db';
import { SourceRow } from '../types';
import { normalizeDoi } from '../citation-service';
import { CrossrefConnector } from '../connectors/crossref';
import { setMetadataVerification } from '../evidence-service';

let connectorOverride: CrossrefConnector | null = null;
export function setConnectorForTesting(c: CrossrefConnector | null): void { connectorOverride = c; }
function connector(): CrossrefConnector { return connectorOverride ?? new CrossrefConnector({ mailto: process.env.ANUCLAW_RESEARCH_STUDIO_CONTACT_EMAIL }); }
const LIVE_ENABLED = () => process.env.ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR === '1' || connectorOverride !== null;

function titleYearMatch(a: string, b: string, yearA: number | null, yearB: number | null): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const ta = norm(a), tb = norm(b);
  const titleOk = ta === tb || (ta.length > 8 && tb.length > 8 && (ta.includes(tb) || tb.includes(ta)));
  const yearOk = !yearA || !yearB || yearA === yearB;
  return titleOk && yearOk;
}

const sourceVerifierAgent: AgentHandler = async (ctx) => {
  const sources = await db.query<SourceRow>(`SELECT * FROM research_studio_sources WHERE project_id = $1 AND metadata_verification_status = 'unknown'`, [ctx.project.id]);
  if (!sources.length) return { kind: 'completed', result: { schema: 'anuclaw-research-studio-verify-sources/v1', verified: 0, mismatched: 0, unverified: 0, note: 'No sources awaited verification.' } };
  if (!LIVE_ENABLED()) {
    // Deterministic, no-network check still runs: a source with no DOI at all can be marked 'unverified' honestly without a connector.
    let unverified = 0;
    for (const s of sources) if (!normalizeDoi(s.doi)) { await setMetadataVerification(s.id, ctx.project.id, ctx.project.owner_id, 'unverified'); unverified++; }
    const withDoi = sources.length - unverified;
    if (!withDoi) return { kind: 'completed', result: { schema: 'anuclaw-research-studio-verify-sources/v1', verified: 0, mismatched: 0, unverified, note: 'No source had a DOI to check; nothing required the live connector.' } };
    return { kind: 'awaiting_user', reason: `${unverified} source(s) with no DOI were marked 'unverified' (nothing to check). ${withDoi} source(s) have a DOI but the live connector is opt-in and not enabled (set ANUCLAW_RESEARCH_STUDIO_LIVE_CONNECTOR=1) — their metadata_verification_status stays 'unknown', never guessed.` };
  }

  let verified = 0, mismatched = 0, unverified = 0;
  for (const s of sources) {
    const usage = await recordUsage(ctx.task, ctx.token, { actions: 1 });
    if (!usage.ok) return { kind: 'failed', reason: 'Task action budget exhausted during source verification.' };
    const doi = normalizeDoi(s.doi);
    if (!doi) { await setMetadataVerification(s.id, ctx.project.id, ctx.project.owner_id, 'unverified'); unverified++; continue; }
    let work; try { work = await connector().lookupByDoi(doi); } catch { work = undefined; }
    if (work === undefined) { continue; } // connector error for THIS source: leave 'unknown', retry on a future run — never guessed
    if (work === null) { await setMetadataVerification(s.id, ctx.project.id, ctx.project.owner_id, 'mismatch'); mismatched++; continue; }
    const ok = titleYearMatch(s.title, work.title, s.year, work.year);
    await setMetadataVerification(s.id, ctx.project.id, ctx.project.owner_id, ok ? 'verified' : 'mismatch');
    if (work.correctionStatus !== 'none') await db.query('UPDATE research_studio_sources SET correction_status = $2 WHERE id = $1', [s.id, work.correctionStatus]);
    if (ok) verified++; else mismatched++;
  }
  return { kind: 'completed', result: { schema: 'anuclaw-research-studio-verify-sources/v1', checked: sources.length, verified, mismatched, unverified } };
};

export function registerSourceVerifier(): void { registerAgent('literature.verify_sources', sourceVerifierAgent); }
