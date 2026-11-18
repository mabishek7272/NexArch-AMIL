import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Badge, Button, Drawer, Field, Input } from '../ui';
import MolecularViewer from '../structure/MolecularViewer';
import './alphafold.css';

type Model = {
  modelId: string;
  uniprotAccessions: string[];
  proteinNames: string[];
  genes: string[];
  organisms: string[];
  sequenceLength: number | null;
  range: { start: number; end: number } | null;
  chain: string | null;
  category: string | null;
  modelType: string | null;
  entryUrl: string;
  entities: {
    identifier: string | null;
    chains: string[];
    stoichiometry: number | null;
    description: string | null;
  }[];
  assembly: string | null;
  oligomericState: string | null;
  files: { key: string; format: string; url: string }[];
  confidence: {
    meanPlddt: number | null;
    type: string | null;
    average: number | null;
    interfaceMetrics: Record<string, number>;
  };
  provenance: { version: number | null; provider: string | null; tool: string | null };
};
type Lookup = {
  acquisition?: string;
  id: string;
  schema: string;
  models: Model[];
  warnings: { code: string; message: string }[];
  annotations: {
    type: string | null;
    description: string | null;
    residues: number[];
    regions: { start: number; end: number; value: string | null }[];
    source: string | null;
    sourceUrl: string | null;
    evidence: string | null;
    evidenceClass: string;
  }[];
  uniprot: { sequenceLength: number | null } | null;
  sequenceSummary: { length: number; checksum: string } | null;
  coverage: {
    missing: { start: number; end: number }[];
    overlaps: { start: number; end: number; models: string[] }[];
    completeLengthKnown: boolean;
  };
  cache: string;
  retrievedAt: number;
  responseHash: string;
  endpoint: string;
  attribution: string;
  license: string;
};
class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const data = await r.json();
  if (!r.ok)
    throw new ApiError(
      r.status,
      data.code ?? 'error',
      typeof data.error === 'string' ? data.error : (data.error?.message ?? `HTTP ${r.status}`),
    );
  return data;
}
const show = (s: unknown) => (s == null || s === '' ? 'Not supplied' : String(s));
const formatRange = (r: Model['range']) => (r ? `${r.start}–${r.end}` : 'Not supplied');

export default function AlphaFoldPage() {
  const [params] = useSearchParams();
  const location = useLocation();
  const [operation, setOperation] = useState('prediction');
  const [value, setValue] = useState('');
  const [result, setResult] = useState<Lookup | null>(null);
  const [modelId, setModelId] = useState('');
  const [fileKey, setFileKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [imported, setImported] = useState<any>(null);
  const [attachment, setAttachment] = useState<any>(null);
  const [receptor, setReceptor] = useState<any>(null);
  const [projects, setProjects] = useState<{ id: string; title: string }[]>([]);
  const [projectId, setProjectId] = useState(params.get('project') ?? '');
  const [projectError, setProjectError] = useState('');
  const [chain, setChain] = useState('');
  const [criterion, setCriterion] = useState('');
  const [criterionSource, setCriterionSource] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [confidence, setConfidence] = useState<{ format: string; data: any } | null>(null);
  const [provenance, setProvenance] = useState(false);
  const cancel = useRef<AbortController | null>(null);
  const model = result?.models.find((m) => m.modelId === modelId) ?? null;
  const context = location.pathname.includes('dry-lab')
    ? 'Dry Lab → Select receptor structure'
    : location.pathname.includes('evidence-library')
      ? 'Evidence Library → Add public structure'
      : 'Bioinformatics → Structural Biology → AlphaFold DB';
  useEffect(() => {
    request<any>('/research-studio/projects')
      .then((r) => setProjects(r.projects ?? []))
      .catch(() => setProjectError('Projects could not be loaded. Check your session and retry.'));
    return () => cancel.current?.abort();
  }, []);
  async function action(fn: (signal: AbortSignal) => Promise<void>) {
    cancel.current?.abort();
    const controller = new AbortController();
    cancel.current = controller;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await fn(controller.signal);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof ApiError
            ? e
            : new ApiError(0, 'network_error', e instanceof Error ? e.message : 'Request failed.'),
        );
    } finally {
      if (cancel.current === controller) setBusy(false);
    }
  }
  function selectModel(id: string) {
    setModelId(id);
    setFileKey('');
    setImported(null);
    setAttachment(null);
    setReceptor(null);
    setConfidence(null);
    setConfirmed(false);
    setChain('');
  }
  function lookup(refresh = false) {
    return action(async (signal) => {
      setResult(null);
      selectModel('');
      const r = await request<Lookup>(
        '/science/alphafold/lookup',
        { operation, value, refresh },
        signal,
      );
      setResult(r);
      setModelId(r.models[0]?.modelId ?? '');
    });
  }
  function importFile(refresh = false) {
    if (!result || !model) return;
    return action(async (signal) => {
      const r = await request<any>(
        '/science/alphafold/import',
        { lookupId: result.id, modelId: model.modelId, fileKey, refresh },
        signal,
      );
      setImported(r);
      setAttachment(null);
      setReceptor(null);
      setConfidence(null);
      setNotice(
        r.cache === 'hit'
          ? 'Cached artifact reused after SHA-256 verification; no live file retrieval.'
          : 'Artifact imported with immutable SHA-256 provenance.',
      );
      if (r.confidence) setConfidence({format:r.provenance.format,data:r.confidence});
    });
  }
  const derivedChains: string[] =
    imported?.derived?.flatMap((d: any) => d.summary?.chains?.map((c: any) => c.id) ?? []) ?? [];
  const knownChains = [
    ...new Set([
      ...(model?.chain ? [model.chain] : []),
      ...(model?.entities.flatMap((e) => e.chains) ?? []),
      ...derivedChains,
    ]),
  ];
  const pae =
    confidence?.format === 'pae'
      ? Array.isArray(confidence.data)
        ? confidence.data[0]
        : confidence.data
      : null;
  return (
    <div className="af-page">
      <div className="af-breadcrumb">{context}</div>
      <header className="af-header">
        <div>
          <h1>AlphaFold DB</h1>
          <p>Public predicted protein structures · official EMBL-EBI API</p>
        </div>
        <Badge tone="blue">READ ONLY PROVIDER</Badge>
      </header>
      <nav aria-label="Structure workflow" className="af-links">
        <Link to="/nexarch/bioinformatics/structural-biology/alphafold">Structural Biology</Link>
        <Link to="/nexarch/evidence-library">Add public structure</Link>
        <Link to="/nexarch/dry-lab">Select receptor structure</Link>
        <Link to="/nexarch/research-studio">Research Studio</Link>
      </nav>
      <section className="af-card">
        <h2>Find a model</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void lookup();
          }}
        >
          <div className="af-search">
            <Field label="Operation">
              <select
                className="nx-input"
                value={operation}
                onChange={(e) => {
                  setOperation(e.target.value);
                  setValue('');
                  setResult(null);
                  selectModel('');
                }}
              >
                <option value="prediction">UniProt / model ID lookup</option>
                <option value="complex">Complex lookup</option>
                <option value="uniprot">UniProt residue-range summary</option>
                <option value="sequence">Sequence summary search</option>
                <option value="annotations">Annotations (MUTAGEN)</option>
              </select>
            </Field>
            <Field
              label={
                operation === 'sequence'
                  ? 'Amino-acid sequence only'
                  : 'UniProt accession or AlphaFold model ID'
              }
            >
              {operation === 'sequence' ? (
                <textarea
                  className="nx-input"
                  value={value}
                  maxLength={10000}
                  required
                  onChange={(e) => setValue(e.target.value)}
                  rows={3}
                />
              ) : (
                <Input
                  value={value}
                  maxLength={100}
                  placeholder="e.g. P69905 or AF-P69905-F1"
                  required
                  onChange={(e) => setValue(e.target.value)}
                />
              )}
            </Field>
          </div>
          <p className="af-muted">
            {operation === 'sequence'
              ? '20–2,700 standard amino acids. No FASTA headers, patient identifiers or unrelated metadata. This endpoint returns existing sequence matches; it does not generate a prediction.'
              : operation === 'uniprot'
                ? 'The official contract accepts an accession or supported model identifier and returns covered residue ranges. Custom range suffixes are not supported by the current API.'
                : 'Only a validated identifier is sent to AlphaFold DB. No API key is required.'}
          </p>
          <div className="af-actions">
            <Button type="submit" variant="primary" loading={busy}>
              Look up
            </Button>
            <Button type="button" disabled={busy || !value} onClick={() => void lookup(true)}>
              Refresh from provider
            </Button>
            {busy && (
              <Button
                type="button"
                onClick={() => {
                  cancel.current?.abort();
                  setBusy(false);
                  setNotice('Request cancelled.');
                }}
              >
                Cancel request
              </Button>
            )}
          </div>
        </form>
      </section>
      {busy && <p role="status">Requesting bounded public provider data…</p>}
      {notice && (
        <p role="status" className="af-notice">
          {notice}
        </p>
      )}
      {error && (
        <section role="alert" className="af-card af-error">
          <h2>
            {error.status === 404
              ? 'Model unavailable'
              : error.status === 429
                ? 'Rate limit or download budget reached'
                : 'Request unavailable'}
          </h2>
          <p>{error.message}</p>
          <p>Code: {error.code}. No missing values have been inferred.</p>
        </section>
      )}
      {!result && !busy && !error && (
        <section className="af-card af-muted">
          Enter a public identifier or sequence to retrieve model metadata. Files download only
          after you choose a format and import.
        </section>
      )}
      {result && (
        <>
          <div className="af-result-meta">
            <span>
              {result.models.length} model(s) ·{' '}
              {result.acquisition === 'synthetic_fixture' ? 'Synthetic fixture provider — not live AlphaFold DB data' : result.cache === 'hit'
                ? 'Cached response — not live provider verification'
                : result.cache === 'revalidated'
                  ? 'Provider revalidated cached response (304)'
                  : 'Retrieved from official provider'}
            </span>
            <time dateTime={new Date(result.retrievedAt).toISOString()}>
              Retrieved {new Date(result.retrievedAt).toLocaleString()}
            </time>
            <Button onClick={() => setProvenance(true)}>Lookup provenance</Button>
          </div>
          {!result.models.length && operation !== 'annotations' && (
            <section className="af-card">
              No models returned by the provider. Try another supported identifier.
            </section>
          )}
          {result.sequenceSummary && (
            <section className="af-card">
              Sequence summary: {result.sequenceSummary.length} residues · checksum{' '}
              {result.sequenceSummary.checksum}
            </section>
          )}
          {model && (
            <div className="af-grid">
              <aside className="af-card">
                <h2>Models & fragments</h2>
                <label className="nx-label" htmlFor="af-model">
                  Selected model
                </label>
                <select
                  id="af-model"
                  className="nx-input"
                  value={modelId}
                  onChange={(e) => selectModel(e.target.value)}
                >
                  {result.models.map((m, i) => (
                    <option key={`${m.modelId}-${i}`} value={m.modelId}>
                      {m.modelId} · {formatRange(m.range)}
                    </option>
                  ))}
                </select>
                <p>Coverage: {formatRange(model.range)}</p>
                <p>Total UniProt length: {show(result.uniprot?.sequenceLength)}</p>
                <p>Fragment sequence length: {show(model.sequenceLength)}</p>
                <details>
                  <summary>Overlap and missing coverage</summary>
                  {result.coverage.overlaps.map((r, i) => (
                    <p key={i}>
                      {r.models.join(' / ')}: overlap {r.start}–{r.end}
                    </p>
                  ))}
                  {!result.coverage.overlaps.length && <p>No overlapping ranges reported.</p>}
                  {result.coverage.missing.map((r, i) => (
                    <p key={i}>
                      Missing: {r.start}–{r.end}
                    </p>
                  ))}
                  {!result.coverage.completeLengthKnown && (
                    <p>
                      Full sequence length is unknown; missing terminal coverage cannot be
                      established.
                    </p>
                  )}
                  <p>Source: official AlphaFold DB API. Models remain separate.</p>
                </details>
                <a href={model.entryUrl} target="_blank" rel="noreferrer">
                  Open in official AlphaFold DB ↗
                </a>
              </aside>
              <section className="af-card">
                <Badge tone="blue">PREDICTED MODEL</Badge>
                <h2>{model.proteinNames.join(' / ') || model.modelId}</h2>
                <dl className="af-metadata">
                  <dt>Model</dt>
                  <dd>{model.modelId}</dd>
                  <dt>UniProt</dt>
                  <dd>{model.uniprotAccessions.join(', ') || 'Not supplied'}</dd>
                  <dt>Gene</dt>
                  <dd>{model.genes.join(', ') || 'Not supplied'}</dd>
                  <dt>Organism</dt>
                  <dd>{model.organisms.join(', ') || 'Not supplied'}</dd>
                  <dt>Category / type</dt>
                  <dd>
                    {show(model.category)} / {show(model.modelType)}
                  </dd>
                  <dt>Model producer</dt>
                  <dd>{show(model.provenance.provider)}</dd>
                  <dt>Tool / version</dt>
                  <dd>
                    {show(model.provenance.tool)} / {show(model.provenance.version)}
                  </dd>
                  <dt>Confidence</dt>
                  <dd>
                    {show(model.confidence.type)} · {show(model.confidence.average)}
                  </dd>
                </dl>
                <p className="af-info">
                  Confidence is a model estimate. No universal pass/fail threshold is applied.
                </p>
                {Object.entries(model.confidence.interfaceMetrics).map(([k, v]) => (
                  <p key={k}>
                    {k}: {v}
                  </p>
                ))}
                <h3>Complex components</h3>
                <p>
                  Assembly: {show(model.assembly)} · oligomeric state: {show(model.oligomericState)}
                </p>
                {model.entities.length ? (
                  <div className="af-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Entity</th>
                          <th>Chains</th>
                          <th>Stoichiometry</th>
                        </tr>
                      </thead>
                      <tbody>
                        {model.entities.map((e, i) => (
                          <tr key={i}>
                            <td>{e.identifier ?? e.description ?? 'Not supplied'}</td>
                            <td>{e.chains.join(', ') || 'Not supplied'}</td>
                            <td>{show(e.stoichiometry)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>
                    Component entities were not supplied by this endpoint. No complex information
                    inferred.
                  </p>
                )}
              </section>
            </div>
          )}
          {model && (
            <section className="af-card">
              <h2>Import a selected artifact</h2>
              <div className="af-search">
                <Field label="Available file format">
                  <select
                    className="nx-input"
                    value={fileKey}
                    onChange={(e) => setFileKey(e.target.value)}
                  >
                    <option value="">Choose one format</option>
                    {model.files.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.format}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="af-actions">
                  <Button
                    variant="primary"
                    disabled={busy || !fileKey}
                    onClick={() => void importFile()}
                  >
                    Import artifact
                  </Button><Button disabled={busy || !fileKey} onClick={() => void importFile(true)}>Refresh selected artifact</Button>
                </div>
              </div>
              {!model.files.length && (
                <p>
                  No approved file URLs supplied. Use prediction lookup for this model ID to request
                  its available files.
                </p>
              )}
              {imported && (
                <div>
                  <h3>Imported {imported.provenance.format}</h3>
                  <p className="af-hash">SHA-256 {imported.source.sha256}</p>
                  <p>
                    {imported.source.bytes.toLocaleString()} bytes · {imported.source.contentType} ·{' '}
                    {imported.source.license}
                  </p>
                  <Button onClick={() => setProvenance(true)}>Artifact provenance</Button>
                  <a className="nx-btn" href={`/api/science/sources/${imported.source.id}/content`}>
                    Download verified artifact
                  </a>
                  {imported.source.kind === 'structure_file' && (
                    <MolecularViewer
                      sourceId={imported.source.id}
                      format={imported.source.format}
                    />
                  )}
                  {confidence?.format === 'plddt' && (
                    <details open>
                      <summary>Per-residue pLDDT</summary>
                      <div className="af-confidence">
                        <table>
                          <thead>
                            <tr>
                              <th>Residue</th>
                              <th>pLDDT</th>
                            </tr>
                          </thead>
                          <tbody>
                            {confidence.data.residueScores.map((v: {index:number;residue:number|null;plddt:number}, i: number) => (
                              <tr key={i}>
                                <td>{v.residue ?? `Index ${v.index} (number not supplied)`}</td>
                                <td>{v.plddt}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  )}
                  {pae && <PAEView data={pae} />}
                  <h3>Attach to project</h3>
                  {projectError && <p role="alert">{projectError}</p>}
                  <Field label="Owned Research Studio project">
                    <select
                      className="nx-input"
                      value={projectId}
                      onChange={(e) => {
                        setProjectId(e.target.value);
                        setAttachment(null);
                        setReceptor(null);
                      }}
                    >
                      <option value="">Choose a project</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title || p.id}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Button
                    disabled={!projectId || busy}
                    onClick={() =>
                      void action(async (signal) => {
                        setAttachment(
                          await request(
                            `/science/alphafold/projects/${projectId}/attachments`,
                            { importId: imported.id },
                            signal,
                          ),
                        );
                        setNotice('Structure source and artifact attached to the owned project.');
                      })
                    }
                  >
                    Attach to project
                  </Button>
                  {attachment && imported.source.kind === 'structure_file' && (
                    <section className="af-handoff">
                      <h3>Dry Lab receptor handoff</h3>
                      <p>
                        Preparation required. Vina needs prepared PDBQT. This action records an
                        input artifact and does not launch docking.
                      </p>
                      <Field label="Selected chain">
                        <select
                          className="nx-input"
                          value={chain}
                          onChange={(e) => setChain(e.target.value)}
                        >
                          <option value="">Choose chain</option>
                          {knownChains.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Project review criterion (optional)">
                        <Input
                          value={criterion}
                          maxLength={1000}
                          onChange={(e) => setCriterion(e.target.value)}
                        />
                      </Field>
                      <Field label="Criterion source (required when criterion is set)">
                        <Input
                          value={criterionSource}
                          maxLength={1000}
                          onChange={(e) => setCriterionSource(e.target.value)}
                        />
                      </Field>
                      <label className="af-confirm">
                        <input
                          type="checkbox"
                          checked={confirmed}
                          onChange={(e) => setConfirmed(e.target.checked)}
                        />
                        I confirm the selected model, chain and coverage and acknowledge
                        predicted-model uncertainty.
                      </label>
                      <Button
                        disabled={busy || !confirmed || !chain || !!criterion !== !!criterionSource}
                        onClick={() =>
                          void action(async (signal) => {
                            setReceptor(
                              await request(
                                `/science/alphafold/projects/${projectId}/receptors`,
                                {
                                  attachmentId: attachment.id,
                                  chain,
                                  criterion,
                                  criterionSource,
                                  confirmed,
                                },
                                signal,
                              ),
                            );
                            setNotice(
                              'Receptor input recorded. Preparation and a separate docking action are still required.',
                            );
                          })
                        }
                      >
                        Record receptor input
                      </Button>
                      {receptor && (
                        <p role="status">
                          Receptor {receptor.id} · preparation: {receptor.preparationStatus} ·
                          tool/version: not yet supplied.{' '}
                          <a
                            href={`/api/science/alphafold/projects/${projectId}/receptors/${receptor.id}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Export handoff provenance
                          </a>
                        </p>
                      )}
                    </section>
                  )}
                </div>
              )}
            </section>
          )}
          {operation === 'annotations' && (
            <section className="af-card">
              <h2>Annotations</h2>
              {!result.annotations.length && <p>No annotations returned.</p>}
              <div className="af-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Description / residues</th>
                      <th>Evidence class</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.annotations.map((a, i) => (
                      <tr key={i}>
                        <td>{show(a.type)}</td>
                        <td>
                          {show(a.description)}
                          <details>
                            <summary>
                              {a.residues.length} residues / {a.regions.length} regions
                            </summary>
                            {a.regions.map((r, j) => (
                              <p key={j}>
                                {r.start}–{r.end}: {show(r.value)}
                              </p>
                            ))}
                            {a.residues.join(', ')}
                          </details>
                        </td>
                        <td>
                          <Badge tone={a.evidenceClass === 'computational' ? 'blue' : 'neutral'}>
                            {a.evidenceClass}
                          </Badge>
                          <p>{show(a.evidence)}</p>
                        </td>
                        <td>
                          {show(a.source)}
                          {a.sourceUrl && (
                            <a href={a.sourceUrl} target="_blank" rel="noreferrer">
                              Source ↗
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <section className="af-card af-warnings">
            <h2>Scientific interpretation</h2>
            <ul>
              {result.warnings.map((w) => (
                <li key={w.code}>{w.message}</li>
              ))}
            </ul>
          </section>
          <footer className="af-muted">
            {result.attribution} ·{' '}
            <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
              CC BY 4.0
            </a>{' '}
            ·{' '}
            <a href="https://www.ebi.ac.uk/about/terms-of-use/" target="_blank" rel="noreferrer">
              EMBL-EBI terms
            </a>
            . NexArch retrieves these predictions; it does not own or generate them.
          </footer>
        </>
      )}
      <Drawer open={provenance} onClose={() => setProvenance(false)} title="AlphaFold provenance">
        <div className="af-provenance">
          <p>Public model metadata; private project associations.</p>
          <pre>{JSON.stringify(imported?.provenance ?? result, null, 2)}</pre>
        </div>
      </Drawer>
    </div>
  );
}
function PAEView({
  data,
}: {
  data: { matrix: number[][]; maxPae?: number };
}) {
  const matrix = data.matrix;
  const [row, setRow] = useState(0);
  return (
    <section>
      <h3>Predicted aligned error (PAE)</h3>
      <p>
        Maximum PAE supplied: {show(data.maxPae)} Å. Inspect the matrix before
        interpreting domain orientation.
      </p>
      <PAEHeatmap matrix={matrix} />
      <label htmlFor="af-pae-row">Aligned residue row (1–{matrix.length})</label>
      <input
        id="af-pae-row"
        className="nx-input"
        type="number"
        min={1}
        max={matrix.length}
        value={row + 1}
        onChange={(e) =>
          setRow(Math.max(0, Math.min(matrix.length - 1, Number(e.target.value) - 1)))
        }
      />
      <div className="af-confidence">
        <table>
          <thead>
            <tr>
              <th>Aligned residue</th>
              <th>Scored residue</th>
              <th>PAE (Å)</th>
            </tr>
          </thead>
          <tbody>
            {matrix[row]?.map((v, i) => (
              <tr key={i}>
                <td>{row + 1}</td>
                <td>{i + 1}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PAEHeatmap({ matrix }: { matrix: number[][] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d'); if (!ctx || !matrix.length) return;
    const side = Math.min(matrix.length,180), step = matrix.length/side;
    let max = 0; for (let i=0;i<side;i++) for (let j=0;j<side;j++) max=Math.max(max,matrix[Math.floor(i*step)][Math.floor(j*step)]);
    for (let i=0;i<side;i++) for(let j=0;j<side;j++) { const ratio = max ? matrix[Math.floor(i*step)][Math.floor(j*step)]/max : 0; ctx.fillStyle=`rgb(${Math.round(25+220*ratio)},${Math.round(85+160*ratio)},${Math.round(60+185*ratio)})`;ctx.fillRect(j*300/side,i*300/side,Math.ceil(300/side),Math.ceil(300/side)); }
  },[matrix]);
  return <figure><canvas ref={ref} width={300} height={300} style={{maxWidth:'100%',height:'auto'}} role="img" aria-label="PAE matrix overview: darker green is lower error, lighter is higher error; exact values are available in the row table."/><figcaption>Matrix overview sampled for display; the row table retains exact PAE values.</figcaption></figure>;
}
