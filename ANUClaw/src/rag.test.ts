import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the query layer — no real database is touched.
vi.mock('./db', () => ({ db: { query: vi.fn(), queryOne: vi.fn() } }));
vi.mock('./logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { db } from './db';
import { retrieveContext } from './rag';

const query = vi.mocked(db.query);

/** Synthetic memory facts keyed by group. Contains no real patient data. */
const FACTS_BY_GROUP: Record<string, Array<Record<string, unknown>>> = {
  'group-a': [
    { key: 'preferred_units', value: 'metric dosing units', confidence: 0.9, source: 'user' },
  ],
  'group-b': [
    { key: 'other_group_secret', value: 'metric value from another group', confidence: 0.9, source: 'user' },
  ],
};

let tmpRoot: string;

function writeSkill(name: string, body: string): void {
  const dir = path.join(tmpRoot, 'container', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf8');
}

function allSql(): string[] {
  return query.mock.calls.map(([sql]) => String(sql));
}

beforeEach(() => {
  query.mockReset();
  // Group-scoped fake: rows are returned only for the group_id parameter given.
  query.mockImplementation(async (sql: string, params?: any[]) => {
    if (/FROM\s+memory_facts/i.test(sql)) return FACTS_BY_GROUP[params?.[0]] ?? [];
    // Any other query (including `patients`) returns a record that must never surface.
    return [{ name: 'SHOULD-NOT-APPEAR', uid: 'X-1', dob: 'x', sex: 'x', conditions: 'x', medications: 'x', risk_level: 'x' }];
  });

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-test-'));
  // rag.ts resolves ./container/skills against process.cwd().
  vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('retrieveContext — patient retrieval disabled (F01)', () => {
  it('never queries the patients table, even for patient-like prompts', async () => {
    const ctx = await retrieveContext(
      'Summarise patient Smith conditions medications warfarin diabetes uid P-123',
      'group-a',
    );

    expect(allSql().some((sql) => /\bpatients\b/i.test(sql))).toBe(false);
    expect(ctx).not.toContain('<patient_records>');
    expect(ctx).not.toContain('SHOULD-NOT-APPEAR');
  });

  it('issues only the group-scoped memory_facts query', async () => {
    await retrieveContext('metric dosing question about units', 'group-a');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/FROM\s+memory_facts/i);
    expect(sql).toMatch(/group_id\s*=\s*\$1/i);
    expect(params).toEqual(['group-a']);
  });
});

describe('retrieveContext — preserved behaviour', () => {
  it('returns facts for the requesting group and not for other groups', async () => {
    const ctx = await retrieveContext('metric dosing question about units', 'group-a');

    expect(ctx).toContain('<historical_session_facts>');
    expect(ctx).toContain('Fact [preferred_units]: metric dosing units');
    expect(ctx).not.toContain('other_group_secret');
  });

  it('returns matching skill guideline excerpts', async () => {
    writeSkill('anuclaw-medical-report-analyzer', '# Medical report analyzer\nParses laboratory report values and units.');
    writeSkill('anuclaw-protein', '# Protein\nStructure prediction.');

    const ctx = await retrieveContext('analyse this laboratory report please', 'group-none');

    expect(ctx).toContain('<clinical_guidelines>');
    expect(ctx).toContain('Source Skill: anuclaw-medical-report-analyzer');
    expect(ctx).not.toContain('anuclaw-protein');
  });

  it('still returns skill context when the memory query fails', async () => {
    writeSkill('anuclaw-medical-report-analyzer', 'laboratory report analyzer');
    query.mockRejectedValue(new Error('connection refused'));

    const ctx = await retrieveContext('laboratory report', 'group-a');

    expect(ctx).toContain('Source Skill: anuclaw-medical-report-analyzer');
    expect(ctx).not.toContain('<historical_session_facts>');
  });
});

describe('retrieveContext — empty context', () => {
  it('returns an empty string and makes no queries when the prompt has no keywords', async () => {
    const ctx = await retrieveContext('hi, how are you?', 'group-a');

    expect(ctx).toBe('');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns an empty string when no skills or facts match', async () => {
    const ctx = await retrieveContext('completely unrelated question', 'group-none');

    expect(ctx).toBe('');
  });
});
