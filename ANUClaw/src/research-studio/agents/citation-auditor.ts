/**
 * Citation Auditor (M4, plan §3-4), task type 'citation.audit'. Deterministic — validates, SEPARATELY, three things
 * for every claim a section cites: (1) does the claim's source identifier resolve (reuses the Source Verifier's own
 * metadata_verification_status — never re-checks it differently), (2) does the cited excerpt have a locator, and
 * (3) is the claim's support status something other than 'unknown'/'unresolved'. A section that cites no claims at
 * all gets 'unknown' for all three — never 'clean' by default, since nothing was actually checked.
 */
import * as crypto from 'crypto';
import { AgentHandler } from '../types';
import { registerAgent } from '../agent-registry';
import { db } from '../../db';
import { currentSections, listSectionClaims } from '../manuscript-service';
import { listClaimLinks } from '../evidence-service';
import { ExcerptRow, SourceRow, CitationAuditStatus } from '../types';

interface ClaimFinding { claimId: string; identifiersResolved: 'unknown' | 'yes' | 'no'; locatorsPresent: 'unknown' | 'yes' | 'no'; claimSupportKnown: 'unknown' | 'yes' | 'no' }
interface SectionFinding { sectionId: string; sectionKey: string; claims: ClaimFinding[]; overallStatus: CitationAuditStatus }

async function auditSection(projectId: string, ownerId: string, sectionId: string, sectionKey: string): Promise<SectionFinding> {
  const links = await listSectionClaims(sectionId, projectId);
  if (!links.length) return { sectionId, sectionKey, claims: [], overallStatus: 'unknown' };
  const claims: ClaimFinding[] = [];
  for (const link of links) {
    const evidenceLinks = await listClaimLinks(link.claim_id, projectId, ownerId);
    if (!evidenceLinks.length) { claims.push({ claimId: link.claim_id, identifiersResolved: 'unknown', locatorsPresent: 'unknown', claimSupportKnown: 'unknown' }); continue; }
    let identifiersResolved: 'unknown' | 'yes' | 'no' = 'unknown'; let locatorsPresent: 'unknown' | 'yes' | 'no' = 'unknown'; let claimSupportKnown: 'unknown' | 'yes' | 'no' = 'unknown';
    for (const el of evidenceLinks) {
      const excerpt = await db.queryOne<ExcerptRow>('SELECT * FROM research_studio_excerpts WHERE id = $1', [el.excerpt_id]);
      if (excerpt) {
        const source = await db.queryOne<SourceRow>('SELECT * FROM research_studio_sources WHERE id = $1', [excerpt.source_id]);
        if (source) identifiersResolved = source.metadata_verification_status === 'verified' ? 'yes' : source.metadata_verification_status === 'mismatch' ? 'no' : identifiersResolved;
        locatorsPresent = Object.keys(JSON.parse(excerpt.locator_json)).length > 0 ? (locatorsPresent === 'no' ? 'no' : 'yes') : 'no';
      }
      if (el.claim_support_status === 'supported' || el.claim_support_status === 'contradicted') claimSupportKnown = 'yes';
      else if (claimSupportKnown !== 'yes') claimSupportKnown = 'no';
    }
    claims.push({ claimId: link.claim_id, identifiersResolved, locatorsPresent, claimSupportKnown });
  }
  const anyNo = claims.some((c) => c.identifiersResolved === 'no' || c.locatorsPresent === 'no' || c.claimSupportKnown === 'no');
  const allYes = claims.every((c) => c.identifiersResolved === 'yes' && c.locatorsPresent === 'yes' && c.claimSupportKnown === 'yes');
  return { sectionId, sectionKey, claims, overallStatus: anyNo ? 'issues_found' : allYes ? 'clean' : 'unknown' };
}

const citationAuditorAgent: AgentHandler = async (ctx) => {
  const sections = await currentSections(ctx.project.id, ctx.project.owner_id);
  const contentSections = sections.filter((s) => s.kind !== 'outline');
  if (!contentSections.length) return { kind: 'failed', reason: 'No sections exist yet to audit.' };
  const findings: SectionFinding[] = [];
  for (const s of contentSections) {
    const f = await auditSection(ctx.project.id, ctx.project.owner_id, s.id, s.section_key);
    findings.push(f);
    await db.query('INSERT INTO research_studio_citation_audits (id, project_id, section_id, task_id, findings_json, overall_status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [crypto.randomUUID(), ctx.project.id, s.id, ctx.task.id, JSON.stringify(f), f.overallStatus, Date.now()]);
  }
  const issues = findings.filter((f) => f.overallStatus === 'issues_found').length;
  return { kind: 'completed', result: { schema: 'anuclaw-research-studio-citation-audit/v1', sectionsAudited: findings.length, issuesFound: issues, findings } };
};

export function registerCitationAuditor(): void { registerAgent('citation.audit', citationAuditorAgent); }
