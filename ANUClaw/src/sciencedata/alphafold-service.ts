/** Scoped AlphaFold orchestration. Reuses science blobs, shared limits, Research Studio ownership/artifacts/invalidation. */
import { randomUUID } from 'crypto';
import { db } from '../db';
import { WorkflowError } from '../documents/workflow';
import { ownProject } from '../research-studio/permissions';
import {
  createSource,
  recordArtifact,
  reviseSourceMetadata,
} from '../research-studio/evidence-service';
import { invalidateSectionsForTasks } from '../research-studio/manuscript-service';
import { invalidateVisualsForTasks } from '../research-studio/visual-service';
import { storeStructureArtifact } from '../research-studio/import-service';
import {
  pgAcquireLease,
  pgRateHit,
  pgReleaseLease,
  pgReserveUnits,
} from '../security/shared-limits';
import {
  AlphaFoldConnector,
  AF_ORIGIN,
  AFFile,
  AFModel,
  AFNormalized,
  AFOperation,
  AF_SCHEMA,
  AF_WARNINGS,
  officialFile,
  normalizeConfidenceArtifact,
} from './alphafold';
import { science, ScienceService, Scope, sha256 } from './service';
import { PROVIDERS } from './providers';
import { ScienceError } from './types';
import { parseMmcif, parsePdb } from './parsers';

const fail = (status: number, code: string, message: string): never => {
  throw new WorkflowError(status, code, message);
};
const nf = (): never => fail(404, 'not_found', 'Not found.');
const envInt = (key: string, fallback: number, max: number): number => {
  const n = Number(process.env[key]);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};
export function alphaFoldLimits() {
  return {
    userPerMinute: envInt('ANUCLAW_AF_USER_RPM', 30, 600),
    tenantPerMinute: envInt('ANUCLAW_AF_TENANT_RPM', 120, 1200),
    concurrentDownloads: envInt('ANUCLAW_AF_CONCURRENT_DOWNLOADS', 2, 8),
    maxFileBytes: envInt('ANUCLAW_AF_MAX_FILE_BYTES', 20e6, 20e6),
    dailyBytes: envInt('ANUCLAW_AF_DAILY_BYTES', 200e6, 1e9),
    cacheTtlMs: envInt('ANUCLAW_AF_CACHE_TTL_MS', 60000, 3600000),
  };
}
function asWorkflow(e: unknown): never {
  if (e instanceof ScienceError) throw new WorkflowError(e.status, e.code, e.message, e.details);
  throw e;
}
export function validateStructureBytes(
  format: AFFile['format'],
  bytes: Buffer,
  contentType: string,
): void {
  const type = contentType.split(';')[0].trim().toLowerCase();
  const types: Record<AFFile['format'], string[]> = {
    pdb: ['chemical/x-pdb', 'text/plain', 'application/octet-stream'],
    mmcif: ['chemical/x-cif', 'chemical/x-mmcif', 'text/plain', 'application/octet-stream'],
    bcif: ['application/octet-stream', 'application/vnd.binarycif'],
    pae: ['application/json'],
    plddt: ['application/json'],
  };
  if (!types[format].includes(type))
    throw new ScienceError(
      'bad_content_type',
      'Coordinate/confidence content type does not match selected format.',
      502,
    );
  if (format === 'pdb') parsePdb(bytes.toString('utf8'), { bFactorIsPlddt: true });
  else if (format === 'mmcif') parseMmcif(bytes.toString('utf8'), { bFactorIsPlddt: true });
  else if (format === 'bcif') {
    // BinaryCIF is MessagePack. Require map envelope and standard signature keys; never accept text/executable headers.
    if (
      !((bytes[0] >= 0x80 && bytes[0] <= 0x8f) || bytes[0] === 0xde || bytes[0] === 0xdf) ||
      !bytes.includes(Buffer.from('dataBlocks')) ||
      !bytes.includes(Buffer.from('encoder'))
    )
      throw new ScienceError('malformed_response', 'Invalid BinaryCIF envelope.', 502);
  } else {
    let payload: any;
    try {
      payload = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ScienceError('malformed_response', 'Invalid confidence JSON.', 502);
    }
    normalizeConfidenceArtifact(format,payload);
  }
}
export class AlphaFoldService {
  readonly connector: AlphaFoldConnector;
  constructor(readonly sci: ScienceService) {
    this.connector = new AlphaFoldConnector(
      sci.fetcher,
      sci.cfg.bases.alphafold,
      process.env.ANUCLAW_AF_CACHE_TTL_MS ? alphaFoldLimits().cacheTtlMs : sci.cfg.describeTtlMs ?? alphaFoldLimits().cacheTtlMs,
    );
  }
  private async rate(scope: Scope, userId: string) {
    const limits = alphaFoldLimits();
    const entries: Array<[string,number]> = scope.kind === 'user' ? [[`user:${userId}`,limits.userPerMinute]] : [[`tenant:${scope.id}`,limits.tenantPerMinute]];
    for (const [key,max] of entries) {
      const r = await pgRateHit(`alphafold:${key}`, max, 60000);
      if (!r.allowed)
        fail(429, 'rate_limited', `AlphaFold request limit reached. Retry in ${r.retryAfterSec}s.`);
    }
  }
  async lookup(
    scope: Scope,
    userId: string,
    operation: AFOperation,
    value: unknown,
    refresh = false,
    signal?: AbortSignal,
  ) {
    await this.rate(scope, userId);
    try {
      const r = await this.connector.lookup(operation, value, refresh, signal);
      const meta = await this.sci.storeSource(
        scope,
        {
          acquisition: this.connector.origin === AF_ORIGIN ? 'live' : 'synthetic_fixture',
          replayNote: this.connector.origin === AF_ORIGIN ? null : 'Synthetic local fixture provider, not live AlphaFold DB evidence.',
          provider: 'alphafold',
          accession:
            operation === 'sequence' ? `SEQ-${r.cacheKey.split(':')[1]}` : r.cacheKey.split(':')[1],
          kind: 'record_metadata',
          classification: 'metadata_only',
          classificationNote:
            'Raw official AlphaFold metadata; subject structures are predictions.',
          format: 'json',
          url: r.raw.finalUrl,
          finalUrl: r.raw.finalUrl,
          version: AF_SCHEMA,
          bytes: r.raw.body,
          contentType: r.raw.headers['content-type'] ?? null,
          etag: r.raw.headers.etag ?? null,
          parent: null,
          member: '',
          retrievedAt: r.retrievedAt,
        },
        PROVIDERS.alphafold,
      );
      const id = randomUUID();
      const now = Date.now();
      await db.query(
        `INSERT INTO sci_af_lookups (id,scope_kind,scope_id,requested_by,operation,cache_key,metadata_source_id,response_sha256,normalized_json,retrieval_endpoint,retrieved_at,checked_at,cache_status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id,
          scope.kind,
          scope.id,
          userId,
          operation,
          r.cacheKey,
          meta.id,
          r.responseHash,
          JSON.stringify(r.normalized),
          r.raw.finalUrl,
          r.retrievedAt,
          r.checkedAt,
          r.cache,
          now,
        ],
      );
      return {
        id,
        acquisition: this.connector.origin === AF_ORIGIN ? 'live' : 'synthetic_fixture',
        ...r.normalized,
        metadataSourceId: meta.id,
        responseHash: r.responseHash,
        cache: r.cache,
        retrievedAt: r.retrievedAt,
        checkedAt: r.checkedAt,
        endpoint: r.raw.finalUrl,
        license: PROVIDERS.alphafold.license,
        attribution: PROVIDERS.alphafold.attribution,
        termsUrl: 'https://www.ebi.ac.uk/about/terms-of-use/',
        limits: alphaFoldLimits(),
      };
    } catch (e) {
      return asWorkflow(e);
    }
  }
  private async ownLookup(scope: Scope, id: string) {
    const row = await db.queryOne<any>(
      'SELECT * FROM sci_af_lookups WHERE id=$1 AND scope_kind=$2 AND scope_id=$3',
      [id, scope.kind, scope.id],
    );
    if (!row) return nf();
    return row;
  }
  async getLookup(scope: Scope, id: string) {
    const r = await this.ownLookup(scope, id);
    return {
      id,
      ...JSON.parse(r.normalized_json),
      responseHash: r.response_sha256.trim(),
      retrievedAt: Number(r.retrieved_at),
      checkedAt: Number(r.checked_at),
      cache: r.cache_status,
      endpoint: r.retrieval_endpoint,
    };
  }
  async importFile(
    scope: Scope,
    userId: string,
    input: { lookupId: string; modelId: string; fileKey: string; refresh?: boolean },
    signal?: AbortSignal,
  ) {
    await this.rate(scope, userId);
    const lookup = await this.ownLookup(scope, input.lookupId);
    const normalized: AFNormalized = JSON.parse(lookup.normalized_json);
    const model = normalized.models.find((m) => m.modelId === input.modelId);
    const file = model?.files.find((f) => f.key === input.fileKey);
    if (!model || !file) return nf();
    if (!officialFile(file.url, file.format, this.connector.origin))
      return fail(400, 'blocked_origin', 'File URL refused.');
    if (!input.refresh) {
      const old = await db.queryOne<any>(
        `SELECT i.* FROM sci_af_imports i WHERE i.scope_kind=$1 AND i.scope_id=$2 AND i.model_id=$3 AND i.file_key=$4 ORDER BY i.created_at DESC LIMIT 1`,
        [scope.kind, scope.id, model.modelId, file.key],
      );
      if (old) {
        const provenance = JSON.parse(old.provenance_json);
        if (
          Date.now() - Number(old.created_at) < alphaFoldLimits().cacheTtlMs &&
          provenance.originalUrl === file.url &&
          provenance.modelVersion === model.provenance.version
        ) {
          await this.sci.readContent(scope, old.source_id);
          const stored = await this.sci.getSource(scope, old.source_id);
          return { ...(await this.getImport(scope,old.id)), cache: 'hit' as const };
        }
      }
    }
    const limits = alphaFoldLimits();
    const lease = await pgAcquireLease(
      'alphafold:downloads:global',
      limits.concurrentDownloads,
      60000,
    );
    if (!lease)
      return fail(429, 'concurrency_limited', 'Maximum concurrent structure downloads reached.');
    try {
      // Reserve before I/O. Exactly one attempt per import, so partial failures cannot overshoot a retry budget.
      const budgetKey = `alphafold:bytes:${scope.kind}:${scope.id}`;
      if (!(await pgReserveUnits(budgetKey, limits.maxFileBytes, limits.dailyBytes, 86400000)))
        return fail(429, 'budget_exhausted', 'Daily download reservation budget exhausted.');
      const r = await this.sci.fetcher.request(file.url, {
        origins: [this.connector.origin],
        maxBytes: Math.min(limits.maxFileBytes, this.sci.cfg.maxFileBytes),
        timeoutMs: 20000,
        retries: 0,
        signal,
        countsAsFile: true,
      });
      if (!officialFile(r.finalUrl,file.format,this.connector.origin)) throw new ScienceError('bad_content_type','Redirected file extension/path does not match the selected format.',502);
      validateStructureBytes(file.format, r.body, r.headers['content-type'] ?? '');
      const source = await this.sci.storeSource(
        scope,
        {
          acquisition: this.connector.origin === AF_ORIGIN ? 'live' : 'synthetic_fixture',
          replayNote: this.connector.origin === AF_ORIGIN ? null : 'Synthetic local fixture provider, not live AlphaFold DB evidence.',
          provider: 'alphafold',
          accession:
            model.uniprotAccessions.length === 1 ? model.uniprotAccessions[0] : model.modelId,
          kind:
            file.format === 'pae' || file.format === 'plddt' ? 'confidence_file' : 'structure_file',
          classification: 'predicted',
          classificationNote: AF_WARNINGS.join(' '),
          format: file.format === 'pae' || file.format === 'plddt' ? 'json' : file.format,
          url: file.url,
          finalUrl: r.finalUrl,
          version: String(model.provenance.version ?? 'unknown'),
          bytes: r.body,
          contentType: r.headers['content-type'] ?? null,
          etag: r.headers.etag ?? null,
          parent: lookup.metadata_source_id,
          member: '',
        },
        PROVIDERS.alphafold,
      );
      const id = randomUUID();
      const provenance = {
        schema: AF_SCHEMA,
        acquisition: this.connector.origin === AF_ORIGIN ? 'live' : 'synthetic_fixture',
        provider: 'AlphaFold DB',
        retrievalEndpoint: lookup.retrieval_endpoint,
        retrievedAt: Date.now(),
        modelId: model.modelId,
        uniprotAccessions: model.uniprotAccessions,
        modelVersion: model.provenance.version,
        modelProvenance: model.provenance,
        format: file.format,
        bytes: r.body.length,
        sha256: source.sha256,
        contentType: r.headers['content-type'] ?? null,
        originalUrl: file.url,
        finalUrl: r.finalUrl,
        license: source.license,
        attribution: source.attribution,
        termsUrl: 'https://www.ebi.ac.uk/about/terms-of-use/',
        scope,
        requestedBy: userId,
        rawMetadataHash: lookup.response_sha256.trim(),
        model,
        warnings: normalized.warnings,
        preparationStatus: 'required',
      };
      await db.query(
        'INSERT INTO sci_af_imports (id,lookup_id,source_id,scope_kind,scope_id,requested_by,model_id,file_key,provenance_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          id,
          lookup.id,
          source.id,
          scope.kind,
          scope.id,
          userId,
          model.modelId,
          file.key,
          JSON.stringify(provenance),
          Date.now(),
        ],
      );
      return {
        id,
        source,
        provenance,
        derived: (await this.sci.getSource(scope, source.id)).derived,
        confidence: file.format === 'pae' || file.format === 'plddt' ? normalizeConfidenceArtifact(file.format,JSON.parse(r.body.toString('utf8'))) : null,
        cache: 'miss' as const,
      };
    } catch (e) {
      return asWorkflow(e);
    } finally {
      await pgReleaseLease(lease);
    }
  }
  async getImport(scope: Scope, id: string) {
    const r = await db.queryOne<any>(
      'SELECT * FROM sci_af_imports WHERE id=$1 AND scope_kind=$2 AND scope_id=$3',
      [id, scope.kind, scope.id],
    );
    if (!r) return nf();
    const content = await this.sci.getSource(scope, r.source_id);
    const provenance = JSON.parse(r.provenance_json);
    const confidence = provenance.format === 'pae' || provenance.format === 'plddt' ? normalizeConfidenceArtifact(provenance.format,JSON.parse((await this.sci.readContent(scope,r.source_id)).bytes.toString('utf8'))) : null;
    return { id, ...content, provenance, confidence };
  }
  async attach(
    scope: Scope,
    userId: string,
    projectId: string,
    importId: string,
    replaces?: string,
  ) {
    await ownProject(projectId, userId); // check BEFORE reading artifact; tenant data never makes a private association public
    const imp = await this.getImport(scope, importId);
    const p = imp.provenance;
    const bytes = await this.sci.readContent(scope, imp.source.id);
    let studioSourceId: string;
    let previous: any = null;
    if (replaces) {
      previous = await db.queryOne<any>(
        'SELECT * FROM research_studio_structure_links WHERE id=$1 AND project_id=$2 AND invalidated_at IS NULL',
        [replaces, projectId],
      );
      if (!previous) return nf();
      studioSourceId = previous.studio_source_id;
    } else {
      const created = await createSource(projectId, userId, {
        title: `${p.modelId} — predicted structure`,
        url: p.model.entryUrl,
        sourceType: 'predicted_structure',
        metadata: p,
        importProvenance: {
          origin: 'alphafold',
          importId,
          sourceId: imp.source.id,
          sha256: imp.source.sha256,
          rawMetadataHash: p.rawMetadataHash,
        },
      });
      studioSourceId = created.source.id;
    }
    const stored = storeStructureArtifact(projectId, studioSourceId, p.format, bytes.bytes);
    if (stored.sha256 !== imp.source.sha256)
      return fail(409, 'integrity_failure', 'Project copy hash mismatch.');
    const artifact = await recordArtifact(
      projectId,
      studioSourceId,
      userId,
      imp.source.kind === 'structure_file' ? 'structure' : 'confidence',
      stored.path,
      stored.sha256,
      stored.size,
    );
    if (previous) {
      const revised = await reviseSourceMetadata(
        previous.studio_source_id,
        projectId,
        userId,
        { metadata: p },
        { origin: 'alphafold', importId },
      );
      await invalidateSectionsForTasks(
        revised.invalidatedTasks,
        'Structure artifact replaced; review model uncertainty again.',
      );
      await invalidateVisualsForTasks(revised.invalidatedTasks, 'Structure artifact replaced.');
    }
    const id = randomUUID();
    await db.transaction(async (tx) => {
      if (previous) {
        await tx.query('UPDATE research_studio_structure_links SET invalidated_at=$1 WHERE id=$2', [
          Date.now(),
          previous.id,
        ]);
        await tx.query('UPDATE sci_af_receptors SET invalidated_at=$1 WHERE attachment_id=$2', [
          Date.now(),
          previous.id,
        ]);
      }
      await tx.query(
        'INSERT INTO research_studio_structure_links (id,project_id,studio_source_id,import_id,artifact_id,created_by,created_at,supersedes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id,
          projectId,
          studioSourceId,
          importId,
          artifact.id,
          userId,
          Date.now(),
          replaces ?? null,
        ],
      );
    });
    return {
      id,
      projectId,
      studioSourceId,
      artifactId: artifact.id,
      sourceId: imp.source.id,
      sha256: stored.sha256,
      provenance: p,
    };
  }
  async attachments(userId: string, projectId: string) {
    await ownProject(projectId, userId);
    const rows = await db.query<any>(
      'SELECT a.*, i.provenance_json FROM research_studio_structure_links a JOIN sci_af_imports i ON i.id=a.import_id WHERE a.project_id=$1 ORDER BY a.created_at',
      [projectId],
    );
    return rows.map(({ provenance_json, ...r }) => ({
      ...r,
      provenance: JSON.parse(provenance_json),
    }));
  }
  async handoff(
    scope: Scope,
    userId: string,
    projectId: string,
    input: {
      attachmentId: string;
      chain?: string;
      criterion?: string;
      criterionSource?: string;
      confirmed?: boolean;
    },
  ) {
    await ownProject(projectId, userId);
    const link = await db.queryOne<any>(
      'SELECT * FROM research_studio_structure_links WHERE id=$1 AND project_id=$2 AND invalidated_at IS NULL',
      [input.attachmentId, projectId],
    );
    if (!link) return nf();
    const imp = await this.getImport(scope, link.import_id);
    if (imp.source.kind !== 'structure_file')
      return fail(400, 'validation', 'Choose a coordinate artifact.');
    if (input.confirmed !== true)
      return fail(
        400,
        'confirmation_required',
        'Human confirmation of predicted-model uncertainty is required.',
      );
    const model: AFModel = imp.provenance.model;
    const knownChains = [
      ...new Set([
        ...(model.chain ? [model.chain] : []),
        ...model.entities.flatMap((e) => e.chains),
        ...imp.derived.flatMap((d: any) => d.summary?.chains?.map((c: any) => c.id) ?? []),
      ]),
    ];
    if (!input.chain || input.chain.length > 20 || !knownChains.includes(input.chain))
      return fail(400, 'validation', 'Select a chain present in the imported model.');
    if (
      !!input.criterion !== !!input.criterionSource ||
      (input.criterion?.length ?? 0) > 1000 ||
      (input.criterionSource?.length ?? 0) > 1000
    )
      return fail(
        400,
        'validation',
        'A project review criterion must include its source (each ≤1,000 characters).',
      );
    const handoff = {
      schema: 'anuclaw-receptor-input/v1',
      engine: 'docking-vina',
      structureArtifactId: link.artifact_id,
      sourceId: imp.source.id,
      sha256: imp.source.sha256,
      modelId: model.modelId,
      chain: input.chain,
      fragment: model.modelId,
      residueCoverage: model.range,
      confidenceWarnings: AF_WARNINGS,
      preparationStatus: 'required',
      preparationTool: null,
      preparationToolVersion: null,
      preparedArtifactId: null,
      reviewCriterion: input.criterion ?? null,
      criterionSource: input.criterionSource ?? null,
      confirmedBy: userId,
      confirmedAt: Date.now(),
      note: 'Raw predicted coordinates are not PDBQT. Receptor preparation and a separate docking confirmation are required.',
    };
    const id = randomUUID();
    await db.query(
      'INSERT INTO sci_af_receptors (id,attachment_id,project_id,created_by,input_json,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, link.id, projectId, userId, JSON.stringify(handoff), Date.now()],
    );
    return { id, ...handoff };
  }
  async getHandoff(userId: string, projectId: string, id: string) {
    await ownProject(projectId, userId);
    const row = await db.queryOne<any>(
      'SELECT * FROM sci_af_receptors WHERE id=$1 AND project_id=$2',
      [id, projectId],
    );
    if (!row) return nf();
    return {
      id,
      ...JSON.parse(row.input_json),
      invalidatedAt: row.invalidated_at ? Number(row.invalidated_at) : null,
    };
  }
}
let singleton: AlphaFoldService | null = null;
export const alphaFold = () => (singleton ??= alphaFoldFor(science()));

const instances = new WeakMap<ScienceService, AlphaFoldService>();
export function alphaFoldFor(sci: ScienceService): AlphaFoldService {
  let s = instances.get(sci);
  if (!s) {
    s = new AlphaFoldService(sci);
    instances.set(sci, s);
  }
  return s;
}
