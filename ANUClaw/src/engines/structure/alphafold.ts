/**
 * Structure lookup — AlphaFold DB engine (Phase 0, WS-A5, RUO).
 *
 * Fetches a predicted protein structure record from the PUBLIC EBI AlphaFold
 * Database (https://alphafold.ebi.ac.uk) by UniProt accession. No API key.
 *
 * This is a `snapshot_only_external` engine: the result is a point-in-time
 * lookup against a remote service, NOT a locally re-derivable computation —
 * the reproducibility class and provenance say so explicitly. Network failure
 * fails closed with EngineError('unavailable').
 */

import { AlphaFoldConnector, AF_ORIGIN, AFModel, normalizeAlphaFold, validateQualifier } from '../../sciencedata/alphafold';
import { SafeFetcher } from '../../sciencedata/fetcher';
import {
  EngineAdapter,
  EngineError,
  EngineResult,
  RunContext,
  hashEngineInput,
  nowIso,
} from '../types';

export interface StructureInput { uniprot: string }
export interface StructureResult {
  models: AFModel[];
  warnings: string[];
  uniprot_accession: string;
  entry_id: string;
  gene?: string;
  organism?: string;
  description?: string;
  sequence_length?: number;
  model_version?: number;
  cif_url?: string;
  pdb_url?: string;
  pae_image_url?: string;
  source: string;
  fetched_at: string;
}

const API = 'https://alphafold.ebi.ac.uk/api/prediction';

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export class AlphaFoldStructureEngine implements EngineAdapter<StructureInput, StructureResult> {
  readonly id = 'structure-alphafold-db';
  readonly version = '2.0.0';
  readonly validated = false; // RUO
  readonly reproducibility_class = 'snapshot_only_external' as const;

  /** fetch is injectable so the parse/mapping logic is testable without network. */
  constructor(private readonly fetchImpl?: FetchLike) {}

  async run(input: StructureInput, ctx?: RunContext): Promise<EngineResult<StructureResult>> {
    const acc = String(input?.uniprot ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6,10}$/.test(acc)) {
      throw new EngineError('invalid_input', 'uniprot must be a UniProt accession (e.g. P69905)');
    }

    let models: AFModel[];
    let warnings: string[];
    try {
      validateQualifier(acc);
      let normalized;
      if (this.fetchImpl) { // deterministic test injection; production always uses bounded SafeFetcher
        const resp = await this.fetchImpl(`${API}/${acc}`, { signal: ctx?.signal, headers: { accept: 'application/json' } });
        if (resp.status === 404) throw new EngineError('invalid_input', 'No AlphaFold model for this accession.');
        if (!resp.ok) throw new EngineError('unavailable', `AlphaFold DB returned ${resp.status}`);
        normalized = normalizeAlphaFold('prediction',await resp.json());
      } else normalized = (await new AlphaFoldConnector(new SafeFetcher({ allowedOrigins: [AF_ORIGIN] })).lookup('prediction',acc,false,ctx?.signal)).normalized;
      models = normalized.models; warnings = normalized.warnings.map((w) => w.message);
    } catch (e) { if (e instanceof EngineError) throw e; throw new EngineError('unavailable', 'AlphaFold DB request failed or returned an unsupported schema.'); }
    const p = models[0];
    if (!p) throw new EngineError('invalid_input', 'No AlphaFold model for this accession.');

    const fetched_at = nowIso(ctx?.now);
    const output: StructureResult = {
      models, warnings,
      uniprot_accession: acc,
      entry_id: p.modelId,
      gene: p.genes[0],
      organism: p.organisms[0],
      description: p.proteinNames[0],
      sequence_length: p.sequenceLength ?? (p.range ? p.range.end-p.range.start+1 : undefined),
      model_version: p.provenance.version ?? undefined,
      cif_url: p.files.find((f)=>f.format==='mmcif')?.url,
      pdb_url: p.files.find((f)=>f.format==='pdb')?.url,
      source: `${API}/${acc}`,
      fetched_at,
    };

    return {
      engine_id: this.id,
      engine_version: this.version,
      input_hash: hashEngineInput(this.id, this.version, { uniprot: acc }),
      output,
      artifacts: [], // metadata lookup does not import bytes; never label a URL as an artifact hash
      provenance: { tool: 'alphafold-db', tool_version: String(p.provenance.version ?? 'unknown'), params: { uniprot: acc }, refdb_versions: { alphafold_db: String(p.provenance.version ?? 'unknown') } },
      reproducibility_class: this.reproducibility_class,
      started_at: fetched_at,
      finished_at: nowIso(ctx?.now),
    };
  }
}
