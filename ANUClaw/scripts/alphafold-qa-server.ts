/** Disposable, loopback-only browser QA. Real app routes/PG; explicitly SYNTHETIC provider fixtures. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Client } from 'pg';
import { startMockProviders } from '../src/sciencedata/testkit';
import { hashPassword } from '../src/security/password';
(async () => {
  if (!process.env.ANUCLAW_TEST_PG_URL) throw new Error('Disposable PostgreSQL URL is required.');
  const admin = new Client({ connectionString: process.env.ANUCLAW_TEST_PG_URL });
  await admin.connect();
  const name = `anuclaw_af_ui_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ui-')),
    mock = await startMockProviders();
  const u = new URL(process.env.ANUCLAW_TEST_PG_URL);
  Object.assign(process.env, {
    PG_HOST: u.hostname,
    PG_PORT: u.port,
    PG_USER: decodeURIComponent(u.username),
    PG_PASSWORD: decodeURIComponent(u.password),
    PG_DATABASE: name,
    DASHBOARD_JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    ANUCLAW_SCIDATA_DIR: path.join(dir, 'science'),
    ANUCLAW_RESEARCH_STUDIO_ROOT: path.join(dir, 'studio'),
    ANUCLAW_SCIDATA_BASE_OVERRIDES: JSON.stringify({ alphafold: mock.origin }),
    ANUCLAW_AF_USER_RPM: '600',
    ANUCLAW_AF_DAILY_BYTES: '1000000000',
    ANUCLAW_SPEND_TRACKING: 'off',
  });
  const { ensureDbReady, getDb } = await import('../src/db/connection');
  await ensureDbReady();
  const { db } = await import('../src/db');
  const { issueTokens } = await import('../src/dashboard/server/auth');
  const id = crypto.randomUUID();
  const qaPassword = process.env.ANUCLAW_AF_QA_PASSWORD;
  if (!qaPassword) throw new Error('An ephemeral QA login password is required.');
  await db.query(
    "INSERT INTO dash_users (id,email,name,role,password_hash,created_at,terms_accepted_at) VALUES ($1,'structure-qa@synthetic.invalid','Synthetic QA','admin',$2,0,$3)",
    [id, await hashPassword(qaPassword), Date.now()],
  );
  const project = await (
    await import('../src/research-studio/project-service')
  ).createProject({
    userId: id,
    mode: 'narrative_review',
    title: 'SYNTHETIC AlphaFold workflow QA',
    brief: {
      topic: 'Structure QA',
      question: 'Can provenance be traced?',
      searchMethod: 'Synthetic fixture provider',
    },
  });
  const app = express();
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'https://fonts.googleapis.com'],
          workerSrc: ["'none'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '40kb' }));
  app.use('/auth', (await import('../src/dashboard/server/routes/users')).default);
  app.use('/api/science', (await import('../src/dashboard/server/routes/science')).default);
  app.use(
    '/api/research-studio',
    (await import('../src/dashboard/server/routes/research-studio')).default,
  );
  app.post('/__fixture', (req, res) => {
    mock.setMode('afJson', String(req.body.mode ?? ''));
    if (req.body.rpm) process.env.ANUCLAW_AF_USER_RPM = String(req.body.rpm);
    res.json({ synthetic: true });
  });
  app.use(express.static(path.resolve('dashboard/dist')));
  app.get('*', (_req, res) => res.sendFile(path.resolve('dashboard/dist/index.html')));
  const server = app.listen(5387, '127.0.0.1', () =>
    console.log('SYNTHETIC AlphaFold QA ready: http://127.0.0.1:5387'),
  );
  const token = (await issueTokens(id)).accessToken;
  fs.writeFileSync(
    '/tmp/anuclaw-af-browser-state.json',
    JSON.stringify({
      cookies: [
        {
          name: 'dash_token',
          value: token,
          domain: '127.0.0.1',
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 3600,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    '/tmp/anuclaw-af-browser-project.json',
    JSON.stringify({ projectId: project.id }),
    { mode: 0o600 },
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await mock.close();
    await getDb().end();
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [
      name,
    ]);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const p of ['/tmp/anuclaw-af-browser-state.json', '/tmp/anuclaw-af-browser-project.json'])
      fs.rmSync(p, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
})().catch((e) => {
  console.error(e instanceof Error ? e.message : 'QA startup failed');
  process.exit(1);
});
