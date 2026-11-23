/**
 * Adapter implementations (interpretation engine, P3). The P2 registry only knows which adapter ids are declared;
 * this module holds the code and flips each id to available when `registerBuiltinAdapters()` runs.
 */
import { declareAdapter, getAdapter } from '../skills/adapters';
import type { Adapter } from './types';
import { beaiveAdapter } from './beaive';
import { posturepulseAdapter } from './posturepulse';

const implementations = new Map<string, Adapter>();

function register(adapter: Adapter, analysisTypes: string[]): void {
  implementations.set(adapter.id, adapter);
  declareAdapter({ id: adapter.id, available: true, analysisTypes });
}

let registered = false;
export function registerBuiltinAdapters(): void {
  if (registered) return;
  registered = true;
  register(beaiveAdapter, getAdapter(beaiveAdapter.id)?.analysisTypes ?? ['face_scan_vitals']);
  register(posturepulseAdapter, getAdapter(posturepulseAdapter.id)?.analysisTypes ?? ['posture_landmark']);
}

export function getAdapterImplementation(id: string): Adapter | undefined { return implementations.get(id); }
