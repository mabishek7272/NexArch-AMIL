/**
 * Isolated LOCAL verification profile (development only; synthetic data only).
 *
 *  - Requires ANUCLAW_TEST_PG_URL pointing at a DISPOSABLE PostgreSQL server. Creates a
 *    randomly named database and drops it on shutdown.
 *  - All configuration is process-scoped: random secrets generated per launch; `.env`
 *    is never read for these values (already-set variables win over dotenv) and never
 *    modified. Nothing real is configured: no channels, no CDS routes (CDS_ENABLED=false).
 *  - API and dashboard bind to 127.0.0.1 only.
 *  - Writes a 0600 JSON descriptor to ANUCLAW_PROFILE_FILE once ready (ports + the
 *    synthetic bootstrap admin credentials, valid only for this profile).
 *
 *   ANUCLAW_TEST_PG_URL=postgres://u:p@127.0.0.1:55432/postgres \
 *   ANUCLAW_PROFILE_FILE=/tmp/profile.json npx tsx scripts/start-local-profile.ts
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'pg';

async function main() {
  const adminUrl = process.env.ANUCLAW_TEST_PG_URL;
  const profileFile = process.env.ANUCLAW_PROFILE_FILE;
  if (!adminUrl || !profileFile) {
    console.error('ANUCLAW_TEST_PG_URL (disposable server) and ANUCLAW_PROFILE_FILE are required.');
    process.exit(2);
  }
  const host = new URL(adminUrl).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.error('Refusing: the test database server must be on loopback.');
    process.exit(2);
  }
  const rnd = (n: number) => crypto.randomBytes(n).toString('hex');
  const dbName = `anuclaw_profile_${rnd(5)}`;
  const u = new URL(adminUrl);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anuclaw-profile-'));
  const adminPassword = `Pf-${rnd(8)}-Ab1!`;
  const ports = { api: Number(process.env.ANUCLAW_PROFILE_API_PORT ?? 4010), dashboard: Number(process.env.ANUCLAW_PROFILE_DASH_PORT ?? 3732) };

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);

  Object.assign(process.env, {
    NODE_ENV: 'development',
    PG_HOST: u.hostname, PG_PORT: u.port || '5432', PG_USER: decodeURIComponent(u.username), PG_PASSWORD: decodeURIComponent(u.password), PG_DATABASE: dbName,
    DASHBOARD_JWT_SECRET: rnd(32), ANUCLAW_JWT_SECRET: rnd(32), ANUCLAW_AUDIT_HMAC_SECRET: rnd(32),
    CDS_ENABLED: 'false', ANUCLAW_API_HOST: '127.0.0.1', API_PORT: String(ports.api), DASHBOARD_PORT: String(ports.dashboard),
    ANUCLAW_BOOTSTRAP_ADMIN_EMAIL: 'profile.admin@clinic-synthetic.org', ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
    ANUCLAW_DOCUMENT_DIR: path.join(tmp, 'documents'), LOG_FILE: path.join(tmp, 'profile.log'),
    ANUCLAW_REGISTER_PER_HOUR: '50',
  });

  // Import AFTER the environment is set (config is read at import time).
  const { ensureDbReady, getDb } = await import('../src/db/connection');
  await ensureDbReady();
  const { startApiServer } = await import('../src/api/server');
  const { mountDashboard } = await import('../src/dashboard/server/index');
  startApiServer();
  mountDashboard();

  fs.writeFileSync(profileFile, JSON.stringify({
    ready: true, pid: process.pid, database: dbName, ports,
    dashboardUrl: `http://127.0.0.1:${ports.dashboard}`, apiUrl: `http://127.0.0.1:${ports.api}`,
    admin: { email: process.env.ANUCLAW_BOOTSTRAP_ADMIN_EMAIL, password: adminPassword },
    ocrServiceUrl: process.env.OCR_SERVICE_URL ?? null,
  }), { mode: 0o600 });
  console.log(`local profile ready: dashboard ${ports.dashboard}, api ${ports.api}, db ${dbName}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    try { await getDb().end(); } catch { /* ignore */ }
    try {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    try { fs.rmSync(profileFile, { force: true }); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error('profile failed:', e?.message ?? e); process.exit(1); });
