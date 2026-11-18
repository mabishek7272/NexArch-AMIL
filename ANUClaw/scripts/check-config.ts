/**
 * Preflight: report whether this environment can start securely.
 * Prints check names and pass/fail reasons only — never values.
 *
 *   npm run check:config
 */
import '../src/config'; // loads .env via dotenv
import { getApiJwtSecret, getDashboardJwtSecret, getAuditHmacSecret } from '../src/security/jwt-secrets';
import { isCdsEnabled, resolveCdsAuth } from '../src/api/middleware/cds-auth';
import { egressMode } from '../src/security/egress-policy';

type Check = { name: string; run: () => string | void; required: boolean };

const checks: Check[] = [
  { name: 'API JWT secret (ANUCLAW_JWT_SECRET)', required: process.env.API_ENABLED !== 'false', run: () => { getApiJwtSecret(); } },
  { name: 'Dashboard JWT secret', required: process.env.DASHBOARD_ENABLED !== 'false', run: () => { getDashboardJwtSecret(); } },
  { name: 'Audit export HMAC (ANUCLAW_AUDIT_HMAC_SECRET)', required: false, run: () => { getAuditHmacSecret(); } },
  {
    name: 'CDS clinical auth', required: process.env.API_ENABLED !== 'false',
    run: () => (isCdsEnabled() ? `mode=${resolveCdsAuth().mode}` : 'CDS routes disabled (CDS_ENABLED=false)'),
  },
  { name: 'Model egress policy', required: false, run: () => `mode=${egressMode()}` },
  {
    name: 'PostgreSQL settings', required: true,
    run: () => {
      const missing = ['PG_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'].filter((k) => !process.env[k]);
      if (missing.length) throw new Error(`not set (built-in local defaults would be used): ${missing.join(', ')}`);
    },
  },
];

let failures = 0;
for (const c of checks) {
  try {
    const note = c.run();
    console.log(`  OK    ${c.name}${note ? ` — ${note}` : ''}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'failed';
    console.log(`  ${c.required ? 'FAIL' : 'WARN'}  ${c.name} — ${msg}`);
    if (c.required) failures++;
  }
}
console.log(failures ? `\n${failures} required check(s) failed; the server would refuse to start.` : '\nAll required checks passed.');
process.exit(failures ? 1 : 0);
