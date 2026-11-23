import * as crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { registerTenant } from '../tenant-store';
import { registerWebhook } from '../../interpretation/webhooks/config';
import { webhookHandler } from '../../interpretation/webhooks/routes';
import { requireAuth, signToken, AuthRequest } from '../middleware/auth';
import { effectiveLimits } from '../middleware/rate-limit';
import { FixedWindowLimiter } from '../../security/throttle';
import { ensureTenantAuditReady, recordTenantEvent } from '../../interpretation/tenancy/audit';
import { ensureSkillRegistry } from '../../interpretation/skills/registry';

const router = Router();

/**
 * POST /api/v1/register
 * Self-service registration. CLOSED by default: tenants are created by an administrator
 * (POST /api/v1/admin/tenants). Set ANUCLAW_SELF_REGISTRATION=open to allow it, e.g. for a local sandbox.
 * Self-registered tenants are always on the free plan; only an administrator can change a plan.
 *
 * Body: { company_name, email }
 */
const registrations = new FixedWindowLimiter(60 * 60 * 1000);

router.post('/register', async (req: Request, res: Response) => {
  if (process.env.ANUCLAW_SELF_REGISTRATION !== 'open') {
    res.status(403).json({ error: 'Tenant registration is by administrator only.', code: 'registration_closed' });
    return;
  }
  // Public endpoint: throttle per client address (in-process; see security/throttle.ts).
  const r = registrations.hit(`reg:${req.ip}`, Number(process.env.ANUCLAW_REGISTER_PER_HOUR ?? 5));
  if (!r.allowed) {
    res.setHeader('Retry-After', String(r.retryAfterSec));
    res.status(429).json({ error: 'Too many registrations from this address. Try later.', code: 'rate_limited' });
    return;
  }
  const { company_name, email, plan } = req.body ?? {};

  if (!company_name || !email) {
    res.status(400).json({ error: 'company_name and email are required.' });
    return;
  }
  if (plan !== undefined && plan !== 'free') {
    res.status(400).json({ error: 'Self-registered tenants start on the free plan; plan changes are made by an administrator.', code: 'plan_requires_admin' });
    return;
  }

  try {
    await ensureTenantAuditReady();
    await ensureSkillRegistry(); // grandfathering must run before this tenant exists (see tenancy/lifecycle.ts)
    const ctx = { actor: 'self_registration', declaredActor: null, requestId: crypto.randomUUID() };
    const tenant = await registerTenant(String(company_name), String(email), 'free', {
      createdBy: 'self_registration',
      afterInsert: async (tx, tenantId) => {
        await recordTenantEvent(tx, tenantId, ctx, 'tenant.created', {
          company_name: String(company_name), email_domain: String(email).split('@')[1]?.toLowerCase() ?? null, plan: 'free', first_key_label: 'initial',
        });
      },
    });
    res.status(201).json({
      message: 'Registration successful. Store your API key securely — it will not be shown again.',
      tenant_id:    tenant.tenant_id,
      company_name: tenant.company_name,
      plan:         tenant.plan,
      api_key:            tenant.api_key,
      rate_limit_per_min: effectiveLimits(tenant).rate,
      monthly_quota:      effectiveLimits(tenant).quota ?? 'unlimited',
      docs: 'https://docs.amgi-research.com/api',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Registration failed.';
    res.status(409).json({ error: msg });
  }
});

/**
 * POST /api/v1/token
 * Exchange an API key for a short-lived JWT (1 hour).
 *
 * Header: X-API-Key: amgi_live_...
 */
router.post('/token', requireAuth, (req: AuthRequest, res: Response) => {
  // Only an API key can mint a token. If a token could mint another token, a revoked key's tokens could be
  // renewed indefinitely; refusing here is what makes "revoke the key" actually end its access.
  if (req.headers.authorization?.startsWith('Bearer ') || !req.apiKeyId) {
    res.status(401).json({ error: 'Authenticate with an API key (X-API-Key) to obtain a token.', code: 'api_key_required' });
    return;
  }
  const tenant = req.tenant!;
  const token = signToken(tenant.tenant_id, req.apiKeyId);
  res.json({
    access_token: token,
    token_type:   'Bearer',
    expires_in:   3600,
    tenant_id:    tenant.tenant_id,
    plan:         tenant.plan,
  });
});

/**
 * GET /api/v1/account
 * Get current tenant account info.
 */
router.get('/account', requireAuth, (req: AuthRequest, res: Response) => {
  const t = req.tenant!;
  res.json({
    tenant_id:          t.tenant_id,
    company_name:       t.company_name,
    email:              t.email,
    plan:               t.plan,
    status:             t.status,
    rate_limit_per_min: effectiveLimits(t).rate,
    monthly_quota:      effectiveLimits(t).quota ?? 'unlimited',
    usage_this_month:   t.usage_this_month,
    usage_total:        t.usage_total,
    webhook_url:        t.webhook_url,
    created_at:         t.created_at,
    last_active_at:     t.last_active_at,
  });
});

/**
 * PUT /api/v1/account/webhook
 * Register (or change) the HTTPS endpoint that receives signed interpretation events.
 *
 * The URL is checked by the SSRF guard: https only, no credentials, public addresses only (private, loopback,
 * link-local and cloud-metadata ranges are refused), and it is re-checked on every delivery. The first registration
 * returns the signing secret ONCE (`signing_secret`); later changes keep the same secret. Use
 * POST /account/webhook/secret/rotate for a new one. See docs/API.md for the signature format.
 *
 * Body: { url }
 */
router.put('/account/webhook', requireAuth, webhookHandler(async (req, res, ctx) => {
  const out = await registerWebhook(req.tenant!.tenant_id, req.body?.url, ctx);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    message: 'Webhook registered.', url: out.url,
    ...(out.signingSecret ? { signing_secret: out.signingSecret, note: 'Store this now: it is shown once and cannot be retrieved again.' } : {}),
  });
}));

/**
 * PUT /api/v1/account/plan
 * A tenant can NOT change its own plan (it would let any tenant raise its own limits). The route is kept so
 * existing clients get an explicit answer instead of a 404; plans are changed by an administrator via
 * PUT /api/v1/admin/tenants/:id/plan.
 */
router.put('/account/plan', requireAuth, (_req: AuthRequest, res: Response) => {
  res.status(403).json({ error: 'Plan changes are made by an administrator.', code: 'plan_change_requires_admin' });
});

export default router;
