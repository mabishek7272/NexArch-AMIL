/** Single place that registers every currently-implemented Research Studio agent — used by the dashboard server at
 * startup and by tests, so the two never drift apart. Unregistered task types (export.manuscript, …) are not
 * listed here on purpose: they stay queued with `agentAvailable: false` until a future milestone adds them. */
import { registerResearchPlanner } from './agents/research-planner';
import { registerLiteratureScout } from './agents/literature-scout';
import { registerSourceVerifier } from './agents/source-verifier';
import { registerEvidenceExtractor } from './agents/evidence-extractor';
import { registerEvidenceMatrixBuilder } from './agents/evidence-matrix-builder';
import { registerBrowserSessionAgent } from './agents/browser-session-agent';
import { registerSynthesisAgent } from './agents/synthesis-agent';
import { registerManuscriptWriter } from './agents/manuscript-writer';
import { registerThesisCoordinator } from './agents/thesis-coordinator';
import { registerMethodsStatisticsAgent } from './agents/methods-statistics-agent';
import { registerCitationAuditor } from './agents/citation-auditor';
import { registerScientificCritic } from './agents/scientific-critic';
import { registerEditorialAgent } from './agents/editorial-agent';
import { registerComplianceAgent } from './agents/compliance-agent';
import { registerVisualAgent } from './agents/visual-agent';
import { registerExportAgent } from './agents/export-agent';

export function registerAllResearchStudioAgents(): void {
  registerResearchPlanner();
  registerLiteratureScout();
  registerSourceVerifier();
  registerEvidenceExtractor();
  registerEvidenceMatrixBuilder();
  registerBrowserSessionAgent(); // simulated provider only — see agents/browser-session-agent.ts
  registerSynthesisAgent();
  registerManuscriptWriter();
  registerThesisCoordinator();
  registerMethodsStatisticsAgent();
  registerCitationAuditor();
  registerScientificCritic();
  registerEditorialAgent();
  registerComplianceAgent();
  registerVisualAgent();
  registerExportAgent();
}
