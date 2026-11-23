/** Strict validators for the two interpretation contracts (interpretation engine, P3a). */
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import requestSchema from './interpretation-request.v1.schema.json';
import findingsSchema from './normalized-findings.v1.schema.json';
import governanceSchema from './governance.v1.schema.json';
import comparisonSchema from './longitudinal-comparison.v1.schema.json';

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const vRequest = ajv.compile(requestSchema);
const vFindings = ajv.compile(findingsSchema);
const vGovernance = ajv.compile(governanceSchema);
const vComparison = ajv.compile(comparisonSchema);

export type Validation = { ok: true } | { ok: false; errors: string[] };

function run(fn: typeof vRequest): (data: unknown) => Validation {
  return (data) => {
    if (fn(data)) return { ok: true };
    // Report paths and rules only, never the offending values (they may be identifiers).
    return { ok: false, errors: (fn.errors ?? []).slice(0, 20).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`) };
  };
}

export const validateInterpretationRequest = run(vRequest);
export const validateNormalizedFindings = run(vFindings);
export const validateGovernance = run(vGovernance);
export const validateLongitudinalComparison = run(vComparison);
