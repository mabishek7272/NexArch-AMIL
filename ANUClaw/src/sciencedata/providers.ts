/**
 * Provider definitions: endpoints, accession rules, metadata normalisation, file plans and classification.
 * Endpoints follow each provider's published API/download documentation:
 *  - AlphaFold DB:  GET https://alphafold.ebi.ac.uk/api/prediction/{UniProt accession}  (JSON list; file URLs inside); files under /files/
 *  - RCSB PDB:      GET https://data.rcsb.org/rest/v1/core/entry/{ID}; files https://files.rcsb.org/download/{ID}.pdb|.cif;
 *                   search POST https://search.rcsb.org/rcsbsearch/v2/query
 *  - NCBI Datasets: GET https://api.ncbi.nlm.nih.gov/datasets/v2/genome/accession/{GCF_/GCA_}/dataset_report and …/download (zip)
 *  - GEO:           SOFT text https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE…&targ=self&form=text&view=brief;
 *                   series matrix https://ftp.ncbi.nlm.nih.gov/geo/series/GSEnnn/GSE…/matrix/…_series_matrix.txt.gz;
 *                   search via E-utilities (db=gds)
 * Base URLs can be overridden ONLY for tests/local demos (ANUCLAW_SCIDATA_BASE_OVERRIDES, non-production, loopback only).
 */
import { AF_QUALIFIER, normalizeAlphaFold } from './alphafold';
import { Classification, ProviderId, ProviderInfo, ScienceError, SourceKind } from './types';

export interface FilePlan { key: string; label: string; kind: SourceKind; classification: Classification; classificationNote: string; format: string; url: string; maxBytes: number; version: string; archive?: boolean; sizeKnownBytes?: number }
export interface RecordDescription {
  provider: ProviderId; accession: string; title: string | null; classification: Classification; classificationNote: string; sourceVersion: string;
  metadata: Record<string, unknown>; files: FilePlan[]; refused?: Array<{ key: string; reason: string }>; warnings: string[];
}

export const DEFAULT_BASES = {
  alphafold: 'https://alphafold.ebi.ac.uk', rcsbData: 'https://data.rcsb.org', rcsbFiles: 'https://files.rcsb.org', rcsbSearch: 'https://search.rcsb.org',
  ncbiDatasets: 'https://api.ncbi.nlm.nih.gov', ncbiEutils: 'https://eutils.ncbi.nlm.nih.gov', ncbiWww: 'https://www.ncbi.nlm.nih.gov', ncbiFtp: 'https://ftp.ncbi.nlm.nih.gov',
};
export type Bases = typeof DEFAULT_BASES;

export function resolveBases(env: NodeJS.ProcessEnv = process.env): Bases {
  const raw = env.ANUCLAW_SCIDATA_BASE_OVERRIDES; if (!raw) return { ...DEFAULT_BASES };
  if ((env.NODE_ENV ?? '').toLowerCase() === 'production') throw new Error('ANUCLAW_SCIDATA_BASE_OVERRIDES is not allowed in production.');
  const o = JSON.parse(raw) as Partial<Bases>; const out = { ...DEFAULT_BASES };
  for (const [k, v] of Object.entries(o)) {
    if (!(k in out) || typeof v !== 'string') throw new Error(`unknown override ${k}`);
    const u = new URL(v); if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('overrides must point at loopback'); (out as Record<string, string>)[k] = u.origin;
  }
  return out;
}
export const allowedOrigins = (b: Bases) => [...new Set(Object.values(b).map((u) => new URL(u).origin))];

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  alphafold: { id: 'alphafold', name: 'AlphaFold Protein Structure Database (EMBL-EBI / Google DeepMind)', origins: ['alphafold.ebi.ac.uk'], accessionPattern: AF_QUALIFIER, accessionExample: 'P69905', searchable: false,
    license: 'CC BY 4.0 (provider-wide policy; see terms URL)', attribution: 'AlphaFold Protein Structure Database, EMBL-EBI; model producer and tool as reported in entry metadata. Cite Jumper et al. 2021 (Nature) and Varadi et al. 2022 (NAR).', termsUrl: 'https://alphafold.ebi.ac.uk/faq', restrictions: 'Computationally PREDICTED models. Retrieving an existing prediction is not running AlphaFold. Lookup by UniProt accession or supported model ID. Subject to EMBL-EBI terms: https://www.ebi.ac.uk/about/terms-of-use/' },
  rcsb: { id: 'rcsb', name: 'RCSB Protein Data Bank', origins: ['data.rcsb.org', 'files.rcsb.org', 'search.rcsb.org'], accessionPattern: '^[0-9][A-Za-z0-9]{3}$', accessionExample: '4HHB', searchable: true,
    license: 'CC0 1.0 for core archive data (provider-wide policy; see terms URL)', attribution: 'RCSB Protein Data Bank (rcsb.org); wwPDB. Cite the entry\'s primary citation.', termsUrl: 'https://www.rcsb.org/pages/usage-policy', restrictions: 'Entries may be experimental OR computed models; the connector reports which, from the record itself.' },
  ncbi_datasets: { id: 'ncbi_datasets', name: 'NCBI Datasets (genome assemblies)', origins: ['api.ncbi.nlm.nih.gov'], accessionPattern: '^GC[AF]_[0-9]{9}\\.[0-9]+$', accessionExample: 'GCF_000819615.1', searchable: true,
    license: 'No single licence: NCBI data are generally public, but submitters may assert rights (provider-wide policy; see terms URL)', attribution: 'NCBI Datasets / RefSeq, National Center for Biotechnology Information.', termsUrl: 'https://www.ncbi.nlm.nih.gov/home/about/policies/', restrictions: 'Assembly accessions only; genomes above the configured size cap are refused (no bulk downloads). Controlled-access data (dbGaP) is out of scope.' },
  geo: { id: 'geo', name: 'NCBI Gene Expression Omnibus (GEO)', origins: ['www.ncbi.nlm.nih.gov', 'ftp.ncbi.nlm.nih.gov', 'eutils.ncbi.nlm.nih.gov'], accessionPattern: '^GSE[0-9]{1,9}$', accessionExample: 'GSE1', searchable: true,
    license: 'No single licence: GEO records are public, but the submitter may attach terms to a record (provider-wide policy; see terms URL)', attribution: 'NCBI GEO; cite the series\' original publication and the GEO accession.', termsUrl: 'https://www.ncbi.nlm.nih.gov/geo/info/disclaimer.html', restrictions: 'Submitter-supplied processed data (author_supplied). Only open GEO records; only small series matrices are fetched; no raw/controlled data.' },
};

export function normalizeAccession(provider: ProviderId, raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const acc = provider === 'alphafold' || provider === 'geo' || provider === 'ncbi_datasets' ? s.toUpperCase().replace(/-MODEL_V/,'-model_v') : s.toUpperCase();
  if (!new RegExp(PROVIDERS[provider].accessionPattern).test(acc)) throw new ScienceError('bad_accession', `'${s.slice(0, 40)}' is not a valid ${PROVIDERS[provider].name.split(' (')[0]} accession (example: ${PROVIDERS[provider].accessionExample}).`, 400);
  return acc;
}
export const SEARCH_TEXT = /^[A-Za-z0-9 .,:+\-_()'/]{2,200}$/;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const must = <T>(v: T | null | undefined, what: string): T => { if (v === null || v === undefined) throw new ScienceError('malformed_response', `The provider response has no ${what}.`, 502); return v; };

export function describeAlphaFold(acc: string, json: unknown, b: Bases): RecordDescription {
  const normalized = normalizeAlphaFold('prediction', json, b.alphafold);
  const files: FilePlan[] = normalized.models.flatMap((m, i) => m.files.map((f) => ({ key: i === 0 ? ({ mmcif: 'cif' } as Record<string, string>)[f.key] ?? f.key : `${m.modelId}:${f.key}`, label: `${m.modelId} (${f.format})`, kind: f.format === 'pae' || f.format === 'plddt' ? 'confidence_file' as const : 'structure_file' as const, classification: 'predicted' as const, classificationNote: normalized.warnings[0].message, format: f.format === 'pae' || f.format === 'plddt' ? 'json' : f.format, url: f.url, maxBytes: 20e6, version: String(m.provenance.version ?? 'unknown') })));
  const m = normalized.models[0];
  return { provider: 'alphafold', accession: acc, title: m?.proteinNames[0] ?? null, classification: 'predicted', classificationNote: 'AlphaFold DB computational prediction; not an experimental structure or clinical evidence.', sourceVersion: m?.provenance.version ? `v${m.provenance.version}` : 'unknown', metadata: { ...normalized, entryId: m?.modelId ?? null, entriesInResponse: normalized.models.length, sequenceLength: m?.sequenceLength ?? (m?.range ? m.range.end - m.range.start + 1 : null), confidence: { meaning: 'pLDDT is a confidence estimate, not experimental evidence and not an accuracy guarantee.', ...m?.confidence, globalMetricValuePlddt: m?.confidence.meanPlddt ?? null } }, files, warnings: normalized.warnings.map((w) => w.message) };
}

export function describeRcsb(id: string, json: unknown, b: Bases): RecordDescription {
  const e = json as Record<string, any>; if (!e || typeof e !== 'object') throw new ScienceError('malformed_response', 'RCSB returned no entry.', 502);
  const rid = must(str(e?.rcsb_id), 'rcsb_id'); if (rid.toUpperCase() !== id) throw new ScienceError('malformed_response', 'RCSB returned a different entry than requested.', 502);
  const methods: string[] = Array.isArray(e.exptl) ? e.exptl.map((x: any) => str(x?.method)).filter(Boolean) as string[] : [];
  const methodology = str(e.rcsb_entry_info?.structure_determination_methodology);
  const computed = methodology === 'computational' || methods.some((m) => /THEORETICAL/i.test(m));
  const acc = e.rcsb_accession_info ?? {};
  const version = `${str(acc.revision_date) ?? str(acc.initial_release_date) ?? 'unknown'}${num(acc.major_revision) !== null ? ` (rev ${acc.major_revision}.${acc.minor_revision ?? 0})` : ''}`;
  const cls: Classification = computed ? 'predicted' : 'experimental';
  const note = computed ? 'This PDB entry is a COMPUTED model (theoretical model), not an experimental structure.' : `Experimental structure determined by ${methods.join(', ') || 'an unspecified method'}.`;
  const files: FilePlan[] = (['pdb', 'cif'] as const).map((f) => ({ key: f, label: `Coordinates (${f === 'pdb' ? 'PDB' : 'mmCIF'})`, kind: 'structure_file', classification: cls, classificationNote: note, format: f === 'pdb' ? 'pdb' : 'mmcif', url: `${b.rcsbFiles}/download/${id}.${f}`, maxBytes: 25e6, version }));
  const res = Array.isArray(e.rcsb_entry_info?.resolution_combined) ? num(e.rcsb_entry_info.resolution_combined[0]) : null;
  return {
    provider: 'rcsb', accession: id, title: str(e.struct?.title), classification: cls, classificationNote: note, sourceVersion: version,
    metadata: { methods, structureDeterminationMethodology: methodology, resolutionAngstrom: res, depositDate: str(acc.deposit_date), initialReleaseDate: str(acc.initial_release_date), revisionDate: str(acc.revision_date), polymerEntityCount: num(e.rcsb_entry_info?.polymer_entity_count), citationTitle: str(e.rcsb_primary_citation?.title), citationDoi: str(e.rcsb_primary_citation?.pdbx_database_id_doi) },
    files, warnings: computed ? ['Computed model: do not treat as experimental evidence.'] : [],
  };
}

export const rcsbSearchBody = (q: string, rows = 10) => ({ query: { type: 'terminal', service: 'full_text', parameters: { value: q } }, return_type: 'entry', request_options: { paginate: { start: 0, rows } } });
export function parseRcsbSearch(json: unknown): Array<{ accession: string; score: number | null }> {
  const j = json as any; if (!j || !Array.isArray(j.result_set)) throw new ScienceError('malformed_response', 'RCSB search returned no result_set.', 502);
  return j.result_set.filter((r: any) => typeof r?.identifier === 'string').slice(0, 25).map((r: any) => ({ accession: String(r.identifier).toUpperCase(), score: num(r.score) }));
}

export function describeNcbiGenome(acc: string, json: unknown, b: Bases, maxGenomeBytes: number): RecordDescription {
  const j = json as any; const r = Array.isArray(j?.reports) ? j.reports[0] : null; if (!r) throw new ScienceError('not_found', 'NCBI has no report for this assembly accession.', 404);
  const got = must(str(r.accession), 'accession'); if (got.toUpperCase() !== acc) throw new ScienceError('malformed_response', 'NCBI returned a different assembly than requested.', 502);
  const len = num(Number(r.assembly_stats?.total_sequence_length)); const refseq = acc.startsWith('GCF_');
  const warnings: string[] = []; const refused: RecordDescription['refused'] = []; const files: FilePlan[] = [];
  const url = `${b.ncbiDatasets}/datasets/v2/genome/accession/${acc}/download?include_annotation_type=GENOME_FASTA&include_annotation_type=GENOME_GFF&hydrated=FULLY_HYDRATED`;
  if (len === null) refused.push({ key: 'genome_zip', reason: 'The assembly size is not reported, so the download cannot be bounded.' });
  else if (len > maxGenomeBytes) refused.push({ key: 'genome_zip', reason: `The assembly is ${(len / 1e6).toFixed(1)} Mbp, above the ${(maxGenomeBytes / 1e6).toFixed(0)} Mbp cap; large genomes are not downloaded by this connector.` });
  else files.push({ key: 'genome_zip', label: 'Genome FASTA + GFF3 annotation (zip)', kind: 'archive', classification: refseq ? 'curated_reference' : 'author_supplied', classificationNote: refseq ? 'RefSeq curated reference assembly.' : 'Submitter-supplied (GenBank) assembly; not curated by NCBI.', format: 'zip', url, maxBytes: Math.min(maxGenomeBytes * 1.2 + 5e6, 64e6), version: acc, archive: true, sizeKnownBytes: len });
  return {
    provider: 'ncbi_datasets', accession: acc, title: str(r.organism?.organism_name) ? `${r.organism.organism_name} — ${str(r.assembly_info?.assembly_name) ?? acc}` : acc,
    classification: refseq ? 'curated_reference' : 'author_supplied', classificationNote: refseq ? 'RefSeq reference assembly (NCBI-curated). Gene annotation in it is computational/curated by NCBI, not experimental evidence.' : 'GenBank submitter-supplied assembly.',
    sourceVersion: `${acc} (${str(r.assembly_info?.release_date) ?? 'release date unknown'})`,
    metadata: { organism: str(r.organism?.organism_name), taxId: num(r.organism?.tax_id), assemblyName: str(r.assembly_info?.assembly_name), assemblyLevel: str(r.assembly_info?.assembly_level), assemblyStatus: str(r.assembly_info?.assembly_status), releaseDate: str(r.assembly_info?.release_date), submitter: str(r.assembly_info?.submitter), sourceDatabase: str(r.source_database), totalSequenceLength: len, contigN50: num(Number(r.assembly_stats?.contig_n50)), gcPercent: num(Number(r.assembly_stats?.gc_percent)), numberOfContigs: num(Number(r.assembly_stats?.number_of_contigs)) },
    files, refused, warnings,
  };
}

export function ncbiTaxonSearchUrl(b: Bases, taxon: string): string { return `${b.ncbiDatasets}/datasets/v2/genome/taxon/${encodeURIComponent(taxon)}/dataset_report?filters.assembly_source=refseq&filters.reference_only=true&page_size=5`; }
export function parseNcbiTaxonSearch(json: unknown): Array<{ accession: string; organism: string | null }> {
  const j = json as any; if (!j || typeof j !== 'object') throw new ScienceError('malformed_response', 'NCBI returned no JSON object.', 502);
  return (Array.isArray(j.reports) ? j.reports : []).filter((r: any) => typeof r?.accession === 'string').slice(0, 10).map((r: any) => ({ accession: String(r.accession), organism: str(r.organism?.organism_name) }));
}

/** SOFT "brief" text → { key: values[] }. Contact/personal fields are dropped on purpose. */
export function parseSoftBrief(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^[!^#]?([A-Za-z_]+)\s*=\s*(.*)$/.exec(line); if (!m) continue;
    const key = m[1]; if (/^Series_contact|contact_/i.test(key)) continue;
    (out[key] ??= []).push(m[2].trim());
  }
  return out;
}
export const geoMatrixUrl = (b: Bases, gse: string) => { const n = gse.slice(3); const stub = n.length > 3 ? `GSE${n.slice(0, -3)}nnn` : 'GSEnnn'; return `${b.ncbiFtp}/geo/series/${stub}/${gse}/matrix/${gse}_series_matrix.txt.gz`; };
export const geoSoftUrl = (b: Bases, gse: string) => `${b.ncbiWww}/geo/query/acc.cgi?acc=${gse}&targ=self&form=text&view=brief`;

export function describeGeo(acc: string, softText: string, b: Bases, matrixMaxBytes: number, matrixSize: number | null): RecordDescription {
  const s = parseSoftBrief(softText);
  const got = (s.SERIES ?? [])[0]; if (!got || got.toUpperCase() !== acc) throw new ScienceError('malformed_response', 'GEO returned a different or empty record.', 502);
  const type = s.Series_type ?? []; const files: FilePlan[] = []; const refused: NonNullable<RecordDescription['refused']> = []; const warnings: string[] = [];
  const supp = (s.Series_supplementary_file ?? []).slice(0, 10);
  if (matrixSize !== null && matrixSize > matrixMaxBytes) refused.push({ key: 'series_matrix', reason: `The series matrix is ${(matrixSize / 1e6).toFixed(1)} MB, above the ${(matrixMaxBytes / 1e6).toFixed(0)} MB cap.` });
  else files.push({ key: 'series_matrix', label: 'Series matrix (processed data, author-supplied)', kind: 'expression_matrix', classification: 'author_supplied', classificationNote: 'Processed values supplied by the submitting authors; not re-processed or validated here. May be a metadata-only matrix.', format: 'series_matrix', url: geoMatrixUrl(b, acc), maxBytes: matrixMaxBytes, version: str((s.Series_last_update_date ?? [])[0]) ?? 'unknown', ...(matrixSize !== null ? { sizeKnownBytes: matrixSize } : {}) });
  if (supp.length) warnings.push(`${supp.length} supplementary file(s) are listed by the submitter; they are not fetched (arbitrary formats, often raw/large).`);
  return {
    provider: 'geo', accession: acc, title: (s.Series_title ?? [])[0] ?? null, classification: 'author_supplied',
    classificationNote: 'GEO series data are submitter-supplied; the connector does not re-process or validate them.', sourceVersion: `last update ${str((s.Series_last_update_date ?? [])[0]) ?? 'unknown'}`,
    metadata: { title: (s.Series_title ?? [])[0] ?? null, summary: (s.Series_summary ?? []).join(' ').slice(0, 2000) || null, overallDesign: (s.Series_overall_design ?? []).join(' ').slice(0, 1000) || null, types: type, platforms: s.Series_platform_id ?? [], sampleCount: (s.Series_sample_id ?? []).length, submissionDate: (s.Series_submission_date ?? [])[0] ?? null, lastUpdateDate: (s.Series_last_update_date ?? [])[0] ?? null, pubmedIds: s.Series_pubmed_id ?? [], supplementaryFilesListed: supp },
    files, refused, warnings,
  };
}

export const geoSearchUrl = (b: Bases, q: string) => `${b.ncbiEutils}/entrez/eutils/esearch.fcgi?db=gds&retmode=json&retmax=5&term=${encodeURIComponent(`${q} AND gse[ETYP]`)}`;
export const geoSummaryUrl = (b: Bases, ids: string[]) => `${b.ncbiEutils}/entrez/eutils/esummary.fcgi?db=gds&retmode=json&id=${ids.map(encodeURIComponent).join(',')}`;
export function parseGeoSearch(json: unknown): string[] { const ids = (json as any)?.esearchresult?.idlist; if (!Array.isArray(ids)) throw new ScienceError('malformed_response', 'GEO search returned no idlist.', 502); return ids.filter((i: unknown) => typeof i === 'string' && /^\d{1,12}$/.test(i)).slice(0, 5); }
export function parseGeoSummary(json: unknown): Array<{ accession: string; title: string | null; taxon: string | null; samples: number | null }> {
  const r = (json as any)?.result; if (!r || !Array.isArray(r.uids)) throw new ScienceError('malformed_response', 'GEO summary returned no result.', 502);
  return r.uids.map((u: string) => r[u]).filter((x: any) => x && typeof x.accession === 'string' && /^GSE\d+$/.test(x.accession)).map((x: any) => ({ accession: x.accession, title: str(x.title), taxon: str(x.taxon), samples: num(Number(x.n_samples)) }));
}
