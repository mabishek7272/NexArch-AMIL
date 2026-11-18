import { describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ db: { query: vi.fn(), queryOne: vi.fn() } }));
vi.mock('../container-runner', () => ({ runAgent: vi.fn() }));
import { TEMPLATES } from '../dashboard/server/routes/pipelines';
import { validateGraph } from './graph';

describe('built-in pipeline templates', () => {
  it.each(TEMPLATES.map((t) => [t.name, t] as const))('%s is a valid DAG with upstream-only references', (_n, t) => {
    expect(validateGraph(t.nodes, t.connections).errors).toEqual([]);
  });
});
