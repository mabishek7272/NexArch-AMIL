import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { logger } from '../logger';

import tenantRoutes from './routes/tenants';
import skillRoutes  from './routes/skills';
import ehrRoutes    from './routes/ehr';
import usageRoutes  from './routes/usage';
import { createCdsRouter } from './routes/cds';
import { isCdsEnabled, resolveCdsAuth, ResolvedCdsAuth } from './middleware/cds-auth';
import { requireAuth, assertApiAuthConfigured } from './middleware/auth';
import { createElabPlatformRouter } from './routes/elab-platform';
import { createElabUiRouter } from './routes/elab-ui';
import { createAdminRouter } from './routes/admin';
import { createTenantAdminRouter } from '../interpretation/tenancy/admin-routes';
import { createSkillAdminRouter } from '../interpretation/skills/admin-routes';
import baasV1Router from './routes/baas-v1';
import { jsonBodyErrorStatus } from './json-errors';
import interpretationRouter from '../interpretation/jobs/routes';
import webhookRouter from '../interpretation/webhooks/routes';
import reportRouter from '../interpretation/reports/routes';
import longitudinalRouter from '../interpretation/longitudinal/routes';
import { createBrandingAdminRouter } from '../interpretation/reports/admin-routes';
import { createReviewQueueRouter } from '../interpretation/reports/review-routes';
import { enableSpendTracking } from '../ai/spend';
import { corsOriginOption, runStartupChecks } from '../startup-checks';
import { createDefaultElabPlatform, resolveTenantContext } from './elab/platform';

const API_PORT   = parseInt(process.env.API_PORT ?? '4000', 10);
const API_PREFIX = '/api/v1';

export interface ApiApp {
  app: express.Express;
  /** CDS auth resolution, or null when CDS routes are intentionally not mounted. */
  cds: ResolvedCdsAuth | null;
  /** Interface to bind; undefined = all interfaces (existing behaviour). */
  bindHost?: string;
}

/**
 * Build the API app and run every startup security check. Throws (refusing to
 * start) if API or CDS clinical authentication is not securely configured.
 */
export function createApiApp(env: NodeJS.ProcessEnv = process.env): ApiApp {
  // Fail closed at startup if ANUCLAW_JWT_SECRET is missing/unsafe (F02).
  assertApiAuthConfigured();
  const corsPolicy = runStartupChecks(env);   // DB credentials + CORS (fail closed in production)
  enableSpendTracking();   // durable model-spend ledger + optional daily budgets

  // Fail closed for the clinical CDS tier: resolveCdsAuth() runs
  // assertClinicalAuthHardened (or the explicit local demo policy) and throws
  // on insecure config. CDS_ENABLED=false skips mounting the CDS routes.
  const cds = isCdsEnabled(env) ? resolveCdsAuth(env) : null;
  // Demo mode is local-only: bind to loopback.
  const bindHost = env.ANUCLAW_API_HOST?.trim() || (cds?.mode === 'demo' ? '127.0.0.1' : undefined);

  const app = express();

  // ── Global middleware ──────────────────────────────────────────────────────
  app.use(helmet());
  app.use(cors({
    origin: corsOriginOption(corsPolicy),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ── Request logger ─────────────────────────────────────────────────────────
  app.use((req, _res, next) => {
    logger.info(`API ${req.method} ${req.path}`);
    next();
  });

  // ── Health check (no auth) ─────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      status:  'ok',
      service: 'ANUClaw API',
      version: '1.0.0',
      built_by: 'AMGI Research — Abi and Anu',
      timestamp: new Date().toISOString(),
    });
  });

  // ── API routes ─────────────────────────────────────────────────────────────
  app.use(`${API_PREFIX}`,          tenantRoutes);
  app.use(`${API_PREFIX}`,          webhookRouter);
  app.use(`${API_PREFIX}/skills`,   skillRoutes);
  app.use(`${API_PREFIX}/ehr`,      ehrRoutes);
  app.use(`${API_PREFIX}/usage`,    usageRoutes);

  // ── CDS v3 (deterministic PGx CDS: CDS Hooks + clinician review) ────────────
  // Mounted at root so the discovery path is the conventional /cds-services.
  if (cds) {
    app.use(createCdsRouter({ auth: cds.config }));
    logger.info(`CDS routes mounted (auth mode: ${cds.mode}).`);
  } else {
    logger.info('CDS routes not mounted (CDS_ENABLED=false).');
  }

  // ── E-LAB platform (tiered RUO / Clinical engine API) ───────────────────────
  // Auth (X-API-Key or Bearer) scoped to the platform paths; tier gating + the
  // RUO de-id gate live in the router's service. Clinical is denied until a
  // tenant is granted clinical scope + an active BAA + enabled domains.
  app.use('/v1/ruo', requireAuth);
  app.use('/v1/clinical', requireAuth);
  app.use(
    createElabPlatformRouter({
      deps: createDefaultElabPlatform(),
      resolveContext: resolveTenantContext,
    }),
  );
  // E-LAB console UI (public page + demo endpoint) at GET /v1/elab.
  app.use(createElabUiRouter());

  // Admin API (tenant clinical-grant) — X-Admin-Key gated, fail-closed if unset.
  app.use(createAdminRouter());
  // Tenant lifecycle + key management (create/suspend/plan/rotate/revoke/audit) — same admin-key guard.
  app.use(createTenantAdminRouter());
  // Skill registry + per-tenant skill assignment — same admin-key guard.
  app.use(createSkillAdminRouter());
  app.use(createBrandingAdminRouter());
  app.use(createReviewQueueRouter());

  // Versioned BaaS API (plan §13): documents → observations → analyses → reports.
  app.use(baasV1Router);
  // Asynchronous interpretation intake (tenant apps post their AI output; polled by id).
  app.use(interpretationRouter);
  app.use(reportRouter);
  app.use(longitudinalRouter);

  // ── Root info ──────────────────────────────────────────────────────────────
  app.get(API_PREFIX, (_req, res) => {
    res.json({
      name:        'ANUClaw API',
      version:     'v1',
      built_by:    'AMGI Research — Abi and Anu',
      endpoints: {
        register:     'POST /api/v1/register',
        token:        'POST /api/v1/token',
        account:      'GET  /api/v1/account',
        skills_list:  'GET  /api/v1/skills',
        skill_run:    'POST /api/v1/skills/:skill/run',
        skill_run_v2: 'POST /api/v1/skills/run',
        ehr_register: 'POST /api/v1/ehr/patients',
        ehr_lookup:   'GET  /api/v1/ehr/patients/:uid',
        ehr_search:   'GET  /api/v1/ehr/patients/search',
        diagnoses:    'POST /api/v1/ehr/patients/:uid/diagnoses',
        prescriptions:'POST /api/v1/ehr/patients/:uid/prescriptions',
        lab_reports:  'POST /api/v1/ehr/patients/:uid/lab-reports',
        hl7:          'POST /api/v1/ehr/patients/:uid/hl7',
        fhir:         'POST /api/v1/ehr/patients/:uid/fhir',
        usage:        'GET  /api/v1/usage',
        webhook:      'PUT  /api/v1/account/webhook',
        cds_discovery:'GET  /cds-services',
        cds_invoke:   'POST /cds-services/anuclaw-pgx-dosing',
        cds_review:   'GET  /cds/review/demo',
        cds_signoff:  'POST /cds/review/signoff',
        cds_audit:    'GET  /cds/review/audit/export',
        elab_ruo:     'POST /v1/ruo/:engineId            (RUO tier — de-id gated)',
        elab_clinical:'POST /v1/clinical/drug-combination (Clinical tier — scope+BAA+domain)',
        elab_console: 'GET  /v1/elab                     (engine console UI)',
        admin_grant:  'POST /api/v1/admin/tenants/:id/clinical-grant (X-Admin-Key)',
      },
      docs: 'https://docs.amgi-research.com/api',
    });
  });

  // ── 404 handler ────────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: 'Endpoint not found.', docs: `${API_PREFIX}` });
  });

  // ── Error handler ──────────────────────────────────────────────────────────
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const bodyError = jsonBodyErrorStatus(err);
    if (bodyError) { res.status(bodyError.status).json({ error: { code: bodyError.code, message: bodyError.message } }); return; }
    logger.error(`Unhandled API error: ${err.message}`);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return { app, cds, bindHost };
}

export function startApiServer(): void {
  const { app, cds, bindHost } = createApiApp();
  const onListen = () => {
    logger.info(`ANUClaw API server running on ${bindHost ?? 'all interfaces'}, port ${API_PORT}`);
    logger.info(`API base: http://localhost:${API_PORT}${API_PREFIX}`);
    if (cds?.mode === 'demo') {
      logger.warn('ANUCLAW_DEMO_MODE is on: CDS accepts the HS256 dev secret and the API is bound to 127.0.0.1. Not for production.');
    }
  };
  if (bindHost) app.listen(API_PORT, bindHost, onListen);
  else app.listen(API_PORT, onListen);
}
