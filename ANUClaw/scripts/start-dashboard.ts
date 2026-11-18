/**
 * Start ONLY the ANUClaw dashboard (backend + built SPA) — no messaging channels.
 * Requires Postgres (per .env PG_*). Serves the dashboard at DASHBOARD_PORT (3722)
 * and migrates the database on first boot. No default administrator exists: on an
 * empty database set ANUCLAW_BOOTSTRAP_ADMIN_EMAIL / ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD
 * once to create the first admin (see .env.example).
 *
 *   npm run start:dashboard   →   http://localhost:3722
 */
import { ensureDbReady } from '../src/db/connection';
import { mountDashboard } from '../src/dashboard/server/index';

(async () => {
  await ensureDbReady(); // migrate (+ first-admin bootstrap if configured)
  mountDashboard();
})().catch((e) => {
  console.error('Dashboard failed to start:', e?.message ?? e);
  process.exit(1);
});
