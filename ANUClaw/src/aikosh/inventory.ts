import * as fs from 'fs';
import * as path from 'path';
import { CATALOG, CatalogEntry, FORCED_RESTRICTED } from './catalog';
import { defaultStatus, FileIdentity } from './policy';

export interface InventoryFile {
  path: string; sizeBytes: number; sha256: string; format: string; rowCount: number | null; rowCountMethod: string; columns: string[]; schema: Record<string, string>; error?: string;
  columnIndicators: unknown[]; indicators: { provenanceFieldsFound: string[]; narrativeColumns: string[]; directIdentifierNameIndicators: string[]; quasiIdentifierColumns: string[]; patternIndicators: string[] };
  nestedRecordCount?: number; topLevelScalarFields?: Record<string, string>; embeddedMetadataKeys?: string[];
}
export interface Inventory { schema: 'anuclaw-aikosh-inventory/v1'; root: string; fileCount: number; files: InventoryFile[] }
export const INVENTORY_PATH = path.resolve(__dirname, '../../governance/aikosh/inventory.generated.json');
export const aikoshRoot = (env: NodeJS.ProcessEnv = process.env) => path.resolve(env.ANUCLAW_AIKOSH_ROOT ?? path.resolve(__dirname, '../../data/aikosh'));
export function loadInventory(file = INVENTORY_PATH): Inventory { const inv = JSON.parse(fs.readFileSync(file, 'utf8')) as Inventory; if (inv.schema !== 'anuclaw-aikosh-inventory/v1') throw new Error('unknown inventory schema'); return inv; }

/** Columns treated as restricted: indicator-detected narrative columns, forced list, and quasi-identifier/ids from the forced list. */
export function restrictedColumns(f: InventoryFile): { narrative: string[]; identifiers: string[] } {
  const forced = FORCED_RESTRICTED[f.path] ?? [];
  const narrative = [...new Set([...f.indicators.narrativeColumns.filter((c) => !/expected_output|confinement|question_text/.test(c)), ...forced.filter((c) => !/^(age|gender|document_id|case_id)$/.test(c))])];
  const identifiers = [...new Set(forced.filter((c) => /^(age|gender|document_id|case_id)$/.test(c)))];
  return { narrative, identifiers };
}
export function identityOf(f: InventoryFile): FileIdentity { const r = restrictedColumns(f); return { path: f.path, sha256: f.sha256, narrativeColumns: r.narrative, identifierColumns: r.identifiers }; }

export interface RegistryEntry {
  path: string; sha256: string; sizeBytes: number; format: string; rowCount: number | null; schema: Record<string, string>; catalog: CatalogEntry | null;
  provenanceFieldsFound: string[]; personalDataIndicators: { narrativeColumns: string[]; identifierColumns: string[]; nameIndicatorColumns: string[]; quasiIdentifierColumns: string[]; patternIndicators: string[]; note: string };
  licence: string; consent: string; deidentification: string; externalProcessing: string; status: string;
}
const UNKNOWN = 'unknown';
export function registryView(inv: Inventory): RegistryEntry[] {
  return inv.files.map((f) => { const r = restrictedColumns(f); return {
    path: f.path, sha256: f.sha256, sizeBytes: f.sizeBytes, format: f.format, rowCount: f.rowCount, schema: f.schema, catalog: CATALOG[f.path] ?? null, provenanceFieldsFound: f.indicators.provenanceFieldsFound,
    personalDataIndicators: { narrativeColumns: r.narrative, identifierColumns: r.identifiers, nameIndicatorColumns: f.indicators.directIdentifierNameIndicators, quasiIdentifierColumns: f.indicators.quasiIdentifierColumns, patternIndicators: f.indicators.patternIndicators,
      note: 'Heuristic hints for a human reviewer (column names and pattern counts on a sample). Many hits are false positives (e.g. numbers matching phone-like patterns); absence proves nothing; none is a de-identification finding.' },
    licence: UNKNOWN, consent: UNKNOWN, deidentification: UNKNOWN, externalProcessing: UNKNOWN, status: defaultStatus() }; });
}
