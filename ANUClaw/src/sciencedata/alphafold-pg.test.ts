/** Real PostgreSQL + real application routes + synthetic provider. No live provider requests. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startMockProviders } from './testkit';
const URL_ = process.env.ANUCLAW_TEST_PG_URL;
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
describe.skipIf(!URL_)(
  'AlphaFold persistence and API routes (PostgreSQL, synthetic HTTP provider)',
  () => {
    const name = `anuclaw_af_${crypto.randomBytes(6).toString('hex')}`,
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-pg-'));
    let admin: Client,
      server: Server,
      mock: Awaited<ReturnType<typeof startMockProviders>>,
      base: string,
      q: any;
    const users: Record<string, string> = {},
      cookies: Record<string, string> = {},
      keys: Record<string, string> = {};
    let projectId: string,
      lookup: any,
      imp: any,
      attachment: any,
      handoff: any,
      sectionId: string,
      excerptId: string;
    beforeAll(async () => {
      admin = new Client({ connectionString: URL_ });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${name}`);
      const u = new URL(URL_!);
      mock = await startMockProviders();
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
        ANUCLAW_AF_DAILY_BYTES: '1000000000',
        ANUCLAW_AF_USER_RPM: '600',
      });
      vi.resetModules();
      await (await import('../db/connection')).ensureDbReady();
      q = (await import('../db')).db.query;
      const auth = await import('../dashboard/server/auth');
      for (const [who, role] of [
        ['a', 'operator'],
        ['b', 'operator'],
        ['viewer', 'viewer'],
      ]) {
        users[who] = crypto.randomUUID();
        await q(
          "INSERT INTO dash_users (id,email,role,password_hash,created_at) VALUES ($1,$2,$3,'x',0)",
          [users[who], `${who}@synthetic.invalid`, role],
        );
        cookies[who] = `dash_token=${(await auth.issueTokens(users[who])).accessToken}`;
      }
      projectId = (
        await (
          await import('../research-studio/project-service')
        ).createProject({
          userId: users.a,
          mode: 'narrative_review',
          title: 'Synthetic structure project',
          brief: {
            topic: 'Predicted structure',
            question: 'How should uncertainty be recorded?',
            searchMethod: 'Synthetic test fixtures',
          },
        })
      ).id;
      const ts = await import('../api/tenant-store');
      for (const who of ['a', 'b'])
        keys[who] = (
          await ts.registerTenant(`Synthetic ${who}`, `${who}@synthetic.invalid`, 'pro')
        ).api_key;
      const express = (await import('express')).default,
        cp = (await import('cookie-parser')).default;
      const app = express();
      app.use(cp());
      app.use(express.json({ limit: '30kb' }));
      app.use('/api/science', (await import('../dashboard/server/routes/science')).default);
      app.use((await import('../api/routes/baas-v1')).default);
      server = await new Promise<Server>((r) => {
        const s = app.listen(0, '127.0.0.1', () => r(s));
      });
      base = `http://127.0.0.1:${(server.address() as any).port}`;
    }, 60000);
    afterAll(async () => {
      if (server) await new Promise<void>((r) => server.close(() => r()));
      if (mock) await mock.close();
      try {
        await (await import('../db/connection')).getDb().end();
      } catch {}
      if (admin) {
        await admin.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1',
          [name],
        );
        await admin.query(`DROP DATABASE IF EXISTS ${name}`);
        await admin.end();
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const call = (who: string | null, p: string, body?: unknown, tenant = false) =>
      fetch(`${base}${tenant ? '/v1/science' : '/api/science'}${p}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(who ? (tenant ? { 'x-api-key': keys[who] } : { cookie: cookies[who] }) : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    it('auth and roles gate public-provider associations', async () => {
      expect(
        (await call(null, '/alphafold/lookup', { operation: 'prediction', value: 'P69905' }))
          .status,
      ).toBe(401);
      expect(
        (await call('viewer', '/alphafold/lookup', { operation: 'prediction', value: 'P69905' }))
          .status,
      ).toBe(403);
    });
    it('lookup persists normalized v1 and raw hash-addressed response, with an owner-only retrieval event', async () => {
      const r = await call('a', '/alphafold/lookup', { operation: 'prediction', value: 'P69905' });
      expect(r.status).toBe(200);
      lookup = await r.json();
      expect(lookup.models[0].modelId).toBe('AF-P69905-F1');
      expect(lookup.responseHash).toMatch(/^[a-f0-9]{64}$/);
      expect(lookup.cache).toBe('miss');
      const rows = await q('SELECT * FROM sci_af_lookups WHERE id=$1', [lookup.id]);
      expect(rows[0].requested_by).toBe(users.a);
      expect(rows[0].scope_id).toBe(users.a);
      expect((await call('b', `/alphafold/lookups/${lookup.id}`)).status).toBe(404);
      const content = await call('a', `/sources/${lookup.metadataSourceId}/content`);
      expect(
        crypto
          .createHash('sha256')
          .update(Buffer.from(await content.arrayBuffer()))
          .digest('hex'),
      ).toBe(lookup.responseHash);
    });
    it('explicit import has byte hash, attribution and metadata linkage; repeated import is a transparent hash-verified cache hit', async () => {
      const body = { lookupId: lookup.id, modelId: 'AF-P69905-F1', fileKey: 'pdb' };
      const r = await call('a', '/alphafold/import', body);
      expect(r.status).toBe(201);
      imp = await r.json();
      expect(imp.source.kind).toBe('structure_file');
      expect(imp.provenance.rawMetadataHash).toBe(lookup.responseHash);
      expect(imp.provenance.license).toContain('CC BY 4.0');
      expect(imp.provenance.scope.id).toBe(users.a);
      expect(imp.source.parentSourceId).toBe(lookup.metadataSourceId);
      mock.hits.length = 0;
      const cached = await (await call('a', '/alphafold/import', body)).json();
      expect(cached.cache).toBe('hit');
      expect(mock.hits).toHaveLength(0);
      expect((await call('b', `/alphafold/imports/${imp.id}`)).status).toBe(404);
      expect((await call('b', '/alphafold/import', body)).status).toBe(404);
      await expect(
        q('UPDATE sci_af_imports SET model_id=$1 WHERE id=$2', ['changed', imp.id]),
      ).rejects.toThrow(/immutable/);
    });
    it('owner-only project attachment stores a verified copy through the existing artifact service and exports attribution', async () => {
      expect(
        (await call('b', `/alphafold/projects/${projectId}/attachments`, { importId: imp.id }))
          .status,
      ).toBe(404);
      const r = await call('a', `/alphafold/projects/${projectId}/attachments`, {
        importId: imp.id,
      });
      expect(r.status).toBe(201);
      attachment = await r.json();
      const a = (
        await q('SELECT * FROM research_studio_artifacts WHERE id=$1', [attachment.artifactId])
      )[0];
      expect(a.kind).toBe('structure');
      expect(a.storage_path).toContain(projectId);
      expect(path.basename(a.storage_path)).toBe(imp.source.sha256);
      expect(
        crypto.createHash('sha256').update(fs.readFileSync(a.storage_path)).digest('hex'),
      ).toBe(imp.source.sha256);
      const source = (
        await q('SELECT * FROM research_studio_sources WHERE id=$1', [attachment.studioSourceId])
      )[0];
      const manifest = (await import('../research-studio/export-service')).buildProvenanceManifest(
        projectId,
        [],
        [source],
        [],
      );
      expect(JSON.stringify(manifest)).toContain('CC BY 4.0');
      expect(JSON.stringify(manifest)).toContain(lookup.responseHash);
    });
    it('receptor handoff requires a present chain, explicit human confirmation and sourced project criteria, never runs docking', async () => {
      const p = `/alphafold/projects/${projectId}/receptors`,
        body = { attachmentId: attachment.id, chain: 'A' };
      expect((await call('a', p, body)).status).toBe(400);
      expect((await call('a', p, { ...body, confirmed: true, chain: 'evil' })).status).toBe(400);
      expect(
        (await call('a', p, { ...body, confirmed: true, criterion: 'Review domain coverage' }))
          .status,
      ).toBe(400);
      const r = await call('a', p, {
        ...body,
        confirmed: true,
        criterion: 'Inspect PAE and receptor coverage',
        criterionSource: 'Synthetic project protocol v1',
      });
      expect(r.status).toBe(201);
      handoff = await r.json();
      expect(handoff).toMatchObject({
        sha256: imp.source.sha256,
        modelId: 'AF-P69905-F1',
        chain: 'A',
        preparationStatus: 'required',
        preparationTool: null,
        preparationToolVersion: null,
        confirmedBy: users.a,
      });
      expect(handoff.confidenceWarnings.join()).toContain('model uncertainty');
      expect((await call('b', `${p}/${handoff.id}`)).status).toBe(404);
    });
    it('a new imported version is a distinct hash; replacement invalidates previous handoff and pins a new artifact', async () => {
      const tasks = await import('../research-studio/task-store');
      const original = await tasks.createTask(projectId, { type: 'evidence.extract' });
      const dependent = await tasks.createTask(projectId, {
        type: 'manuscript.section',
        dependsOn: [original.id],
      });
      await q("UPDATE research_studio_tasks SET status='completed' WHERE id=$1", [dependent.id]);
      const ev = await import('../research-studio/evidence-service');
      excerptId = (
        await ev.createExcerpt(projectId, attachment.studioSourceId, users.a, {
          locator: { section: 'structure' },
          text: 'Synthetic receptor coverage',
          extractedBy: 'human',
          taskId: original.id,
        })
      ).id;
      sectionId = (
        await (
          await import('../research-studio/manuscript-service')
        ).createSection(projectId, users.a, {
          sectionKey: 'structure',
          kind: 'section',
          title: 'Structure uncertainty',
          contentText: 'Synthetic analysis',
          contentSource: 'human',
          taskId: dependent.id,
        })
      ).id;
      mock.mutate({ afVersion: 7 });
      const l = await (
        await call('a', '/alphafold/lookup', {
          operation: 'prediction',
          value: 'P69905',
          refresh: true,
        })
      ).json();
      const next = await (
        await call('a', '/alphafold/import', {
          lookupId: l.id,
          modelId: 'AF-P69905-F1',
          fileKey: 'pdb',
          refresh: true,
        })
      ).json();
      expect(next.source.sha256).not.toBe(imp.source.sha256);
      const r = await call('a', `/alphafold/projects/${projectId}/attachments`, {
        importId: next.id,
        replaces: attachment.id,
      });
      expect(r.status).toBe(201);
      const newer = await r.json();
      expect(newer.artifactId).not.toBe(attachment.artifactId);
      expect(
        (await q('SELECT invalidated_at FROM research_studio_excerpts WHERE id=$1', [excerptId]))[0]
          .invalidated_at,
      ).not.toBeNull();
      expect(
        (await q('SELECT invalidated_at FROM research_studio_sections WHERE id=$1', [sectionId]))[0]
          .invalidated_at,
      ).not.toBeNull();
      expect((await tasks.getTask(dependent.id))?.invalidated_at).not.toBeNull();
      const old = await (
        await call('a', `/alphafold/projects/${projectId}/receptors/${handoff.id}`)
      ).json();
      expect(old.invalidatedAt).toBeGreaterThan(0);
      expect(
        (
          await call('a', `/alphafold/projects/${projectId}/receptors`, {
            attachmentId: attachment.id,
            chain: 'A',
            confirmed: true,
          })
        ).status,
      ).toBe(404);
    });
    it('tenant B cannot enumerate tenant A lookups/imports; identical public payload does not reveal private associations', async () => {
      const a = await (
        await call('a', '/alphafold/lookup', { operation: 'prediction', value: 'P69905' }, true)
      ).json();
      expect((await call('b', `/alphafold/lookups/${a.id}`, undefined, true)).status).toBe(404);
      const b = await (
        await call('b', '/alphafold/lookup', { operation: 'prediction', value: 'P69905' }, true)
      ).json();
      expect(b.responseHash).toBe(a.responseHash);
      expect(b.id).not.toBe(a.id);
    });
    it('limits fail closed and path traversal cannot become local storage paths', async () => {
      process.env.ANUCLAW_AF_USER_RPM = '1';
      expect(
        (await call('a', '/alphafold/lookup', { operation: 'prediction', value: 'P69905' })).status,
      ).toBe(429);
      process.env.ANUCLAW_AF_USER_RPM = '600';
      const store = (await import('../research-studio/import-service')).storeStructureArtifact;
      expect(() => store('../escape', crypto.randomUUID(), 'pdb', Buffer.from('ATOM'))).toThrow();
      process.env.ANUCLAW_AF_DAILY_BYTES = '1';
      expect(
        (
          await call('a', '/alphafold/import', {
            lookupId: lookup.id,
            modelId: 'AF-P69905-F1',
            fileKey: 'pae',
            refresh: true,
          })
        ).status,
      ).toBe(429);
      process.env.ANUCLAW_AF_DAILY_BYTES = '1000000000';
    });
  },
);
