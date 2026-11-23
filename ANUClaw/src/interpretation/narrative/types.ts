/** Types for the narrative stage (interpretation engine, P4b). */
import type { NormalizedFlag } from '../adapters/types';

export type Layer = 'clinical' | 'layman';
export const LAYERS: Layer[] = ['clinical', 'layman'];

export type StatusLabel = 'source_finding' | 'interpretation' | 'limitation';

export interface NarrativeSection { id: string; text: string; findingRefs: string[]; statusLabel: StatusLabel }
export interface Narrative { sections: NarrativeSection[]; nextSteps: string[]; limitations: string }

/** What a layer is told. Never carries identity, the subject reference, free text from a person, or flag prose. */
export interface NarrativeInputFinding {
  key: string; label: string; group?: string;
  /** null = the source reported no value. */
  value: number | string | boolean | null; unit?: string;
  uncertainty?: { plusMinus?: number; interval?: [number, number] };
  reference?: { text?: string; lower?: number; upper?: number; value?: number; status?: 'draft' | 'approved'; suppliedBy: string };
  position: string; positionBasis: string;
  sourceFlag?: string; tier?: string; side?: string; underResearch?: boolean; unsupportedReasons?: string[];
}
export interface NarrativeInput {
  layer: Layer;
  application: string;
  researchStatus?: string;
  verification?: string;
  findings: NarrativeInputFinding[];
  flags: Array<{ type: string; severity: string; findingKeys?: string[] }>;
  notMeasurable?: string[];
  symptomsReported?: boolean;
  /** True when a fixed referral notice is added by the system; the model must neither write nor contradict it. */
  referralNoticeAdded: boolean;
}

export type GuardSeverity = 'hard' | 'soft';
export interface GuardProblem { code: string; severity: GuardSeverity; section?: string }
export interface GuardResult { ok: boolean; problems: GuardProblem[]; readingGrade?: number }

export type LayerSource = 'model' | 'deterministic';
export interface LayerRecord {
  source: LayerSource;
  /** Why the deterministic text was used (absent when the model's text was accepted). */
  fallbackReason?: string;
  /** Model calls made for this layer (at most 2). */
  attempts: number;
  problems: GuardProblem[];
  modelRequested?: string; modelReturned?: string;
  usage?: Record<string, unknown>;
  egressRedactions?: number;
  readingGrade?: number;
}

export interface NarrativeResult {
  mode: 'model' | 'deterministic' | 'model_fallback';
  narratives: Record<Layer, Narrative>;
  layers: Record<Layer, LayerRecord>;
  promptVersions: Record<Layer, string | null>;
  /** Flags the narrative stage adds (kept out of the immutable governance document). */
  flags: NormalizedFlag[];
}
