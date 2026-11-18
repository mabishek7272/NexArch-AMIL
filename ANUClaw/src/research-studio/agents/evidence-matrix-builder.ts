/**
 * Evidence Matrix Builder (M2, plan §3/§5), task type 'evidence.build_matrix'. Purely deterministic aggregation over
 * already-persisted rows (claims, claim-evidence links, excerpts, sources) — no model call, no new judgement. The
 * matrix states, per claim, EXACTLY which excerpts/sources support or contradict it and the recorded
 * claim_support_status of each link; it is a projection of existing decisions, not a new one. An invalidated excerpt
 * is excluded from the "live" view but listed separately so staleness is visible rather than silently dropped.
 */
import { AgentHandler } from '../types';
import { registerAgent } from '../agent-registry';
import { db } from '../../db';
import { ClaimEvidenceLinkRow, ClaimRow, ExcerptRow, SourceRow } from '../types';
import { listClaims, listClaimLinks, saveEvidenceMatrix, summarizeClaimStatus } from '../evidence-service';

const evidenceMatrixBuilderAgent: AgentHandler = async (ctx) => {
  const claims = await listClaims(ctx.project.id, ctx.project.owner_id);
  const excerpts = await db.query<ExcerptRow>('SELECT * FROM research_studio_excerpts WHERE project_id = $1', [ctx.project.id]);
  const excerptsById = new Map(excerpts.map((e) => [e.id, e]));
  const sources = await db.query<SourceRow>('SELECT * FROM research_studio_sources WHERE project_id = $1', [ctx.project.id]);
  const sourcesById = new Map(sources.map((s) => [s.id, s]));

  const rows = [];
  for (const claim of claims as ClaimRow[]) {
    const links = await listClaimLinks(claim.id, ctx.project.id, ctx.project.owner_id);
    const overall = summarizeClaimStatus(links, excerptsById);
    const entries = (links as ClaimEvidenceLinkRow[]).map((l) => {
      const excerpt = excerptsById.get(l.excerpt_id);
      const source = excerpt ? sourcesById.get(excerpt.source_id) : undefined;
      return {
        excerptId: l.excerpt_id, sourceId: excerpt?.source_id ?? null, sourceTitle: source?.title ?? null,
        relation: l.relation, linkSupportStatus: l.claim_support_status, locator: excerpt ? JSON.parse(excerpt.locator_json) : null,
        stale: !!excerpt?.invalidated_at, invalidatedReason: excerpt?.invalidated_reason ?? null,
      };
    });
    rows.push({ claimId: claim.id, statement: claim.statement, overallStatus: overall, evidence: entries });
  }
  const matrix = { schema: 'anuclaw-research-studio-evidence-matrix/v1', projectId: ctx.project.id, claimCount: claims.length, sourceCount: sources.length, excerptCount: excerpts.length, rows };
  await saveEvidenceMatrix(ctx.project.id, ctx.task.id, matrix);
  return { kind: 'completed', result: matrix };
};

export function registerEvidenceMatrixBuilder(): void { registerAgent('evidence.build_matrix', evidenceMatrixBuilderAgent); }
