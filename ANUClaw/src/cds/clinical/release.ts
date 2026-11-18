/**
 * Release gate for generalized clinical decision modules (plan F13). The oncology and neurology rule sets in this repository are
 * SEED/illustrative content ("NOT clinically validated"): they are NOT served unless
 *   (a) docs/clinical-release-register.json has an entry for `cds.<domain>` at exactly the module's rules version, or
 *   (b) a developer explicitly sets ANUCLAW_ENABLE_SEED_CLINICAL_CONTENT=true AND NODE_ENV is not production — in which case
 *       every response is labelled `seed_unvalidated`.
 * Fail closed: an unreadable register means "not released".
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ContentRelease { released: boolean; mode: 'registered' | 'seed_dev_override' | 'blocked'; reason: string }

const REGISTER = path.resolve(__dirname, '../../../docs/clinical-release-register.json');

export function loadRegister(file = REGISTER): Array<{ ruleId: string; ruleVersion: string }> {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j?.releases) ? j.releases.filter((r: any) => typeof r?.ruleId === 'string' && typeof r?.ruleVersion === 'string') : [];
  } catch { return []; }
}

export function clinicalContentRelease(domain: string, rulesVersion: string, env: NodeJS.ProcessEnv = process.env, registerFile?: string): ContentRelease {
  if (loadRegister(registerFile).some((r) => r.ruleId === `cds.${domain}` && r.ruleVersion === rulesVersion)) return { released: true, mode: 'registered', reason: 'listed in the clinical release register' };
  const production = (env.NODE_ENV ?? '').toLowerCase() === 'production';
  if (env.ANUCLAW_ENABLE_SEED_CLINICAL_CONTENT === 'true' && !production) {
    return { released: true, mode: 'seed_dev_override', reason: 'developer override: SEED content, not clinically validated' };
  }
  return {
    released: false, mode: 'blocked',
    reason: `The '${domain}' rule set (${rulesVersion}) is seed/illustrative content with no clinical approval in docs/clinical-release-register.json. ` +
      (production ? 'The developer override is not honoured in production.' : 'For local development only: ANUCLAW_ENABLE_SEED_CLINICAL_CONTENT=true.'),
  };
}
