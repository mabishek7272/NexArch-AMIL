/**
 * Code-defined adapters an interpretation skill can point at (interpretation engine, P2).
 *
 * An adapter converts a tenant application's format into normalized findings (P3). Until an adapter's code exists
 * its entry is a declared slot with `available: false`: a skill may be REGISTERED against it, but cannot be
 * ASSIGNED to a tenant or run, so the registry never promises something that is not implemented. P3 flips each
 * entry with `declareAdapter` when it registers the real implementation.
 */
export interface AdapterInfo {
  id: string;
  available: boolean;
  /** Analysis types the adapter can read; `*` means any. */
  analysisTypes: string[];
}

const adapters = new Map<string, AdapterInfo>([
  ['beaive-v1', { id: 'beaive-v1', available: false, analysisTypes: ['face_scan_vitals'] }],
  ['posturepulse-v1', { id: 'posturepulse-v1', available: false, analysisTypes: ['posture_landmark'] }],
  ['report-clinical-v1', { id: 'report-clinical-v1', available: false, analysisTypes: ['*'] }],
  ['report-layman-v1', { id: 'report-layman-v1', available: false, analysisTypes: ['*'] }],
]);

export function getAdapter(id: string): AdapterInfo | undefined { return adapters.get(id); }
export function isAdapterAvailable(id: string): boolean { return adapters.get(id)?.available === true; }
export function listAdapters(): AdapterInfo[] { return [...adapters.values()]; }

/** Declares or updates an adapter (used when an adapter's implementation is registered, and by tests). */
export function declareAdapter(info: AdapterInfo): void { adapters.set(info.id, { ...info, analysisTypes: [...info.analysisTypes] }); }
