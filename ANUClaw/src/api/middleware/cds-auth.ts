/**
 * Express auth middleware for the CDS endpoints — SMART on FHIR / CDS Hooks
 * (plan §6.5).
 *
 *   cdsHooksAuth   — validates the CDS Hooks JWT on the invocation endpoint
 *                    (signature + exp + issuer allowlist + audience).
 *   smartScopeAuth — validates a SMART access token AND requires scopes for the
 *                    clinician review / sign-off endpoints.
 *
 * FAIL CLOSED (Phase 1 repair, docs/SCAN-2026-11-17.md finding 4): the guards
 * never call next() without a verified token. If auth is not configured they
 * answer 503 (service unavailable, generic message — no config details); a
 * bad/missing caller token is 401; insufficient scope is 403.
 *
 * Startup policy lives in `resolveCdsAuth()`: the API refuses to mount the CDS
 * routes unless `assertClinicalAuthHardened` passes, except in an explicit,
 * still-authenticated local demo mode (`ANUCLAW_DEMO_MODE=true`, never in
 * production) that additionally permits a validated HS256 dev secret.
 */

import { Request, Response, NextFunction } from 'express';
import {
  CdsAuthConfig,
  CdsAuthError,
  TokenClaims,
  extractBearer,
  hasRequiredScopes,
  verifyBearerToken,
  verifyBearerTokenAsync,
} from '../../cds';
import { validateJwtSecret } from '../../security/jwt-secrets';

export interface CdsAuthedRequest extends Request {
  cdsAuth?: TokenClaims;
}

function deny(res: Response, err: unknown): void {
  const status = err instanceof CdsAuthError ? err.status : 401;
  res.status(status).json({ error: err instanceof Error ? err.message : 'unauthorized' });
}

/** True only when the config can actually verify a token. */
export function hasVerificationKey(config: CdsAuthConfig): boolean {
  return Boolean(config.verify || config.jwtPublicKey || config.jwtSecret || config.jwks?.length || config.jwksUri);
}

/**
 * Misconfigured clinical auth → 503 with a generic message. Returns true when the
 * request was answered (caller must stop). Never reveals which setting is missing.
 */
function rejectIfUnconfigured(config: CdsAuthConfig, res: Response): boolean {
  if (config.enabled && hasVerificationKey(config)) return false;
  res.status(503).json({ error: 'Clinical decision support authentication is not configured.', code: 'cds_auth_unavailable' });
  return true;
}

/** Guard the CDS Hooks invocation endpoint with the EHR-issued JWT. */
export function cdsHooksAuth(config: CdsAuthConfig) {
  return (req: CdsAuthedRequest, res: Response, next: NextFunction): void => {
    if (rejectIfUnconfigured(config, res)) return;
    try {
      req.cdsAuth = verifyBearerToken(extractBearer(req.header('authorization')), config);
      next();
    } catch (err) {
      deny(res, err);
    }
  };
}

/** Guard a clinician endpoint with a SMART access token AND required scopes. */
export function smartScopeAuth(config: CdsAuthConfig, requiredScopes: string[]) {
  return (req: CdsAuthedRequest, res: Response, next: NextFunction): void => {
    if (rejectIfUnconfigured(config, res)) return;
    try {
      const claims = verifyBearerToken(extractBearer(req.header('authorization')), config);
      if (!hasRequiredScopes(claims, requiredScopes)) {
        throw new CdsAuthError(403, `Missing required scope(s): ${requiredScopes.join(', ')}`);
      }
      req.cdsAuth = claims;
      next();
    } catch (err) {
      deny(res, err);
    }
  };
}

// ── WS-C5 hardened variants (JWKS-by-kid + asymmetric-only) ───────────────────

/** Hardened CDS Hooks guard — async, supports JWKS + `requireAsymmetric`. */
export function cdsHooksAuthHardened(config: CdsAuthConfig) {
  return async (req: CdsAuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (rejectIfUnconfigured(config, res)) return;
    try {
      req.cdsAuth = await verifyBearerTokenAsync(extractBearer(req.header('authorization')), config);
      next();
    } catch (err) {
      deny(res, err);
    }
  };
}

/** Hardened SMART scope guard — async, supports JWKS + `requireAsymmetric`. */
export function smartScopeAuthHardened(config: CdsAuthConfig, requiredScopes: string[]) {
  return async (req: CdsAuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (rejectIfUnconfigured(config, res)) return;
    try {
      const claims = await verifyBearerTokenAsync(extractBearer(req.header('authorization')), config);
      if (!hasRequiredScopes(claims, requiredScopes)) {
        throw new CdsAuthError(403, `Missing required scope(s): ${requiredScopes.join(', ')}`);
      }
      req.cdsAuth = claims;
      next();
    } catch (err) {
      deny(res, err);
    }
  };
}

/**
 * Fail-closed validation for a Clinical-tier deployment (WS-C5). Call at startup;
 * throws if clinical auth is mis-hardened. Clinical auth CANNOT be disabled, must
 * be asymmetric-only, must not use an HS256 secret, and must have a key source.
 */
export function assertClinicalAuthHardened(config: CdsAuthConfig): void {
  if (!config.enabled) {
    throw new Error('Clinical auth must be enabled (fail-closed): configure a verification key.');
  }
  if (!config.requireAsymmetric) {
    throw new Error('Clinical auth must require asymmetric algorithms (RS256/ES256).');
  }
  if (config.jwtSecret) {
    throw new Error('HS256 shared secret is forbidden for Clinical auth.');
  }
  if (!config.jwks?.length && !config.jwksUri && !config.jwtPublicKey) {
    throw new Error('Clinical auth requires a JWKS (static or URL) or a public key.');
  }
}

/** Build the CDS auth config from environment variables. */
export function cdsAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CdsAuthConfig {
  const jwtPublicKey = env.CDS_JWT_PUBLIC_KEY?.replace(/\\n/g, '\n');
  const jwtSecret = env.CDS_JWT_SECRET;
  const jwksUri = env.CDS_JWKS_URI;
  const hasKey = Boolean(jwtPublicKey || jwtSecret || jwksUri);
  // Pure parser. `enabled` reflects whether a key is configured; there is NO
  // supported way to switch CDS auth off (CDS_AUTH_ENABLED=false is rejected by
  // resolveCdsAuth). An enabled config without a key still fails closed (503).
  const enabled = hasKey || env.CDS_AUTH_ENABLED === 'true';

  return {
    enabled,
    jwtPublicKey,
    jwtSecret,
    jwksUri,
    requireAsymmetric:
      env.CDS_REQUIRE_ASYMMETRIC === 'true' ? true : env.CDS_REQUIRE_ASYMMETRIC === 'false' ? false : undefined,
    trustedIssuers: split(env.CDS_TRUSTED_ISSUERS),
    audience: env.CDS_AUDIENCE,
    requiredScopes: split(env.CDS_REQUIRED_SCOPES) ?? ['user/Patient.read'],
    signOffScopes: split(env.CDS_SIGNOFF_SCOPES) ?? ['user/MedicationRequest.write'],
  };
}

function split(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

// ── Startup policy (fail closed) ──────────────────────────────────────────────

export class CdsAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdsAuthConfigError';
  }
}

export type CdsAuthMode = 'enforced' | 'demo';

export interface ResolvedCdsAuth {
  mode: CdsAuthMode;
  config: CdsAuthConfig;
}

/** NODE_ENV values in which local demo mode may be enabled. */
const DEMO_ALLOWED_NODE_ENVS = new Set(['', 'development', 'test']);

/** Whether the CDS routes should be mounted at all (default: yes). */
export function isCdsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CDS_ENABLED ?? '').trim().toLowerCase() !== 'false';
}

/**
 * Explicit local demo mode. Default off. Only the literal 'true' enables it;
 * any other non-empty value other than 'false' is rejected to avoid ambiguity.
 * Throws if requested outside a local/development NODE_ENV.
 */
export function isDemoModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.ANUCLAW_DEMO_MODE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'false') return false;
  if (raw !== 'true') {
    throw new CdsAuthConfigError("ANUCLAW_DEMO_MODE must be 'true' or 'false'.");
  }
  const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
  if (!DEMO_ALLOWED_NODE_ENVS.has(nodeEnv)) {
    throw new CdsAuthConfigError(
      'ANUCLAW_DEMO_MODE=true is refused: demo mode is only allowed when NODE_ENV is unset, "development" or "test".',
    );
  }
  return true;
}

/**
 * Resolve the CDS auth configuration for startup. Throws CdsAuthConfigError
 * (message names settings, never values) when the clinical tier would be
 * exposed without secure authentication.
 *
 *  - enforced (default): must pass assertClinicalAuthHardened — asymmetric-only,
 *    no HS256 secret, and a JWKS (static/URL) or public key.
 *  - demo (ANUCLAW_DEMO_MODE=true, non-production): still authenticated; also
 *    permits an HS256 CDS_JWT_SECRET that passes the shared secret strength check.
 */
export function resolveCdsAuth(env: NodeJS.ProcessEnv = process.env): ResolvedCdsAuth {
  if ((env.CDS_AUTH_ENABLED ?? '').trim().toLowerCase() === 'false') {
    throw new CdsAuthConfigError(
      'CDS_AUTH_ENABLED=false is not supported: CDS authentication cannot be disabled. ' +
        'Set CDS_ENABLED=false to not mount the CDS routes.',
    );
  }

  const base = cdsAuthConfigFromEnv(env);

  if (isDemoModeEnabled(env)) {
    if (base.jwtSecret) {
      try {
        validateJwtSecret('CDS_JWT_SECRET', base.jwtSecret);
      } catch (err) {
        throw new CdsAuthConfigError(err instanceof Error ? err.message : 'CDS_JWT_SECRET is not acceptable.');
      }
    }
    const config: CdsAuthConfig = {
      ...base,
      enabled: true,
      // HS256 is only usable when asymmetric-only is not forced.
      requireAsymmetric: base.jwtSecret && !base.jwtPublicKey && !base.jwksUri ? false : base.requireAsymmetric,
    };
    if (!hasVerificationKey(config)) {
      throw new CdsAuthConfigError(
        'Demo mode still requires CDS authentication: set CDS_JWT_SECRET (dev) or CDS_JWT_PUBLIC_KEY / CDS_JWKS_URI.',
      );
    }
    return { mode: 'demo', config };
  }

  const config: CdsAuthConfig = {
    ...base,
    enabled: true,
    // Secure default: asymmetric-only unless explicitly set otherwise (which then fails the assertion).
    requireAsymmetric: base.requireAsymmetric ?? true,
  };
  try {
    assertClinicalAuthHardened(config);
    // Token binding: without these, a token signed by the trusted key but minted
    // for a different service/issuer would be accepted.
    if (!config.audience?.trim()) throw new Error('CDS_AUDIENCE (this service\'s URL) is required.');
    if (!config.trustedIssuers?.length) throw new Error('CDS_TRUSTED_ISSUERS (allowed token issuers) is required.');
  } catch (err) {
    throw new CdsAuthConfigError(
      `CDS clinical authentication is not securely configured: ${err instanceof Error ? err.message : 'invalid configuration'} ` +
        '(set CDS_ENABLED=false to run the API without the CDS routes).',
    );
  }
  return { mode: 'enforced', config };
}
