/**
 * PosturePulse contract (plan §9.1): validates payloads against PosturePulse's own
 * versioned JSON Schemas (draft 2020-12) from its packages/schemas/src directory,
 * so ANUClaw consumes the real contract rather than a re-typed copy.
 *
 * ANUCLAW_POSTUREPULSE_SCHEMAS_DIR defaults to the adjacent checkout
 * (<repo>/packages/schemas/src). Missing schemas → the integration is unavailable.
 */
import * as fs from 'fs';
import * as path from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

export type ContractName = 'assessment-report' | 'consent-record' | 'session' | 'symptom-report' | 'metric-result';

export function schemasDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.ANUCLAW_POSTUREPULSE_SCHEMAS_DIR ?? path.join(process.cwd(), '..', '..', 'packages', 'schemas', 'src'));
}

let cached: { dir: string; ajv: Ajv2020 } | null = null;

export function loadContract(dir = schemasDir()): Ajv2020 {
  if (cached?.dir === dir) return cached.ajv;
  if (!fs.existsSync(dir)) throw new Error('PosturePulse schemas directory not found; integration unavailable.');
  // Formats (date-time etc.) ARE validated via ajv-formats.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.schema.json'))) {
    ajv.addSchema(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  cached = { dir, ajv };
  return ajv;
}

export function validateContract(name: ContractName, value: unknown, dir?: string): string[] {
  const ajv = loadContract(dir);
  const id = `https://schemas.beaive.dev/${name}.schema.json`;
  const validate = ajv.getSchema(id);
  if (!validate) return [`schema ${name} not found`];
  if (validate(value)) return [];
  return (validate.errors ?? []).slice(0, 20).map((e) => `${name}${e.instancePath || ''} ${e.message ?? 'invalid'}`);
}
