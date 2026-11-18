/** Release control: clinical rules and the register of their approvals must match exactly. */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CLINICAL_RULES, isReleased } from './rules';
import { NeurologyAsmModule, OncologyCombinationModule } from '../cds/clinical';

const reg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/clinical-release-register.json'), 'utf8'));
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

describe('clinical release register', () => {
  it('every clinical rule has a complete register entry, and every entry has a rule', () => {
    const key = (id: string, v: string) => `${id}@${v}`;
    const entries = new Map<string, any>((reg.releases as any[]).map((e) => [key(e.ruleId, e.ruleVersion), e]));
    expect(entries.size).toBe(reg.releases.length);                                   // no duplicate entries
    for (const r of CLINICAL_RULES) {
      const e = entries.get(key(r.id, r.version));
      expect(e, `no register entry for clinical rule ${r.id}@${r.version}`).toBeTruthy();
      for (const f of ['approverName', 'approverRole', 'licenseOrCredentialRef', 'evidence', 'population', 'intendedUse', 'recordRef']) expect(String(e[f] ?? '').trim().length, `${r.id}: ${f}`).toBeGreaterThan(2);
      expect(ISO_DAY.test(e.approvedAt), `${r.id}: approvedAt`).toBe(true);
      expect(isReleased(r)).toBe(true);
      expect(r.category).toBe('clinical');
      expect(r.approval?.approvedAt).toBe(e.approvedAt);
    }
    // `cds.<domain>` entries release a whole CDS rule set (src/cds/clinical/release.ts); they must name a module that exists at that version.
    const modules = [new OncologyCombinationModule(), new NeurologyAsmModule()].map((m) => key(`cds.${m.domain}`, m.version));
    const ruleKeys = new Set([...CLINICAL_RULES.map((r) => key(r.id, r.version)), ...modules]);
    for (const e of reg.releases.filter((x: any) => String(x.ruleId).startsWith('cds.'))) {
      for (const f of ['approverName', 'approverRole', 'licenseOrCredentialRef', 'evidence', 'population', 'intendedUse', 'recordRef']) expect(String(e[f] ?? '').trim().length, `${e.ruleId}: ${f}`).toBeGreaterThan(2);
      expect(ISO_DAY.test(e.approvedAt), `${e.ruleId}: approvedAt`).toBe(true);
    }
    for (const k of entries.keys()) expect(ruleKeys.has(k), `register entry ${k} has no rule`).toBe(true);
  });
  it('this build releases no clinical rule (no approval exists)', () => {
    expect(CLINICAL_RULES).toHaveLength(0); expect(reg.releases).toHaveLength(0);
  });
});
