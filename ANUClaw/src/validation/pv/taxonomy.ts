/** Error taxonomy for posture and monitoring validation runs. Descriptive categories for analysis; none is a clinical severity. */
export const ERROR_CLASSES = ['capture_failure', 'no_pose', 'low_confidence', 'occlusion', 'calibration', 'disagreement', 'unsupported_condition', 'gate_violation_measurement_where_unmeasurable', 'false_rejection', 'missing_output', 'unclassified'] as const;
export type ErrorClass = typeof ERROR_CLASSES[number];
/** System-reported reason codes (an `unsupported` result must carry one; a missing one is itself a finding). */
export const REASON_TO_CLASS: Record<string, ErrorClass> = {
  capture_failed: 'capture_failure', subject_out_of_frame: 'capture_failure', no_pose_detected: 'no_pose', low_pose_confidence: 'low_confidence', low_image_quality: 'low_confidence', insufficient_light: 'low_confidence',
  occluded: 'occlusion', scale_unknown: 'calibration', calibration_missing: 'calibration', rotation_out_of_range: 'unsupported_condition', multiple_people: 'unsupported_condition', unsupported_condition: 'unsupported_condition',
};
export function classifyReason(reason: string | undefined | null): ErrorClass { return reason && REASON_TO_CLASS[reason] ? REASON_TO_CLASS[reason] : 'unclassified'; }
export const TAXONOMY_NOTE = 'Categories describe why an output was absent or wrong. "disagreement" is assigned only when the caller supplies a disagreement tolerance (none is chosen here). No category is a clinical severity.';
