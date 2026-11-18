import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ db: { query: vi.fn(), queryOne: vi.fn() } }));
vi.mock('./container-runner', () => ({ runAgent: vi.fn() }));
vi.mock('./channels/registry', () => ({ findChannel: () => undefined }));
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { assertValidCron, reconcile, TaskRow } from './task-scheduler';

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 't1', name: 'n', cron: '0 6 * * *', skill: '', prompt: 'p', group_id: null, channel: null, enabled: 1, updated_at: 1, created_at: 0, ...over,
});

function harness() {
  const created: string[] = [];
  const stopped: string[] = [];
  const factory = (t: TaskRow) => { created.push(`${t.id}@${t.cron}`); return { stop: () => stopped.push(t.id) }; };
  return { created, stopped, factory, registry: new Map() };
}

describe('reconcile', () => {
  it('schedules enabled tasks once', () => {
    const h = harness();
    reconcile([task()], h.factory, h.registry);
    reconcile([task()], h.factory, h.registry);
    expect(h.created).toEqual(['t1@0 6 * * *']);
  });

  it('re-creates a job when its cron/prompt/updated_at changes (previously skipped)', () => {
    const h = harness();
    reconcile([task()], h.factory, h.registry);
    reconcile([task({ cron: '30 7 * * *', updated_at: 2 })], h.factory, h.registry);
    expect(h.stopped).toEqual(['t1']);
    expect(h.created).toEqual(['t1@0 6 * * *', 't1@30 7 * * *']);
  });

  it('stops jobs for disabled or deleted tasks', () => {
    const h = harness();
    reconcile([task(), task({ id: 't2' })], h.factory, h.registry);
    reconcile([task({ enabled: 0 })], h.factory, h.registry);
    expect(h.stopped.sort()).toEqual(['t1', 't2']);
    expect(h.registry.size).toBe(0);
  });

  it('an invalid schedule is not scheduled and does not break others', () => {
    const h = harness();
    const factory = (t: TaskRow) => { if (t.id === 'bad') throw new Error('bad cron'); return h.factory(t); };
    reconcile([task({ id: 'bad' }), task()], factory, h.registry);
    expect([...h.registry.keys()]).toEqual(['t1']);
  });
});

describe('assertValidCron', () => {
  it.each(['0 6 * * *', '*/5 * * * *'])('accepts %s', (c) => expect(() => assertValidCron(c)).not.toThrow());
  it.each(['', 'not a cron', '99 * * * *'])('rejects %j', (c) => expect(() => assertValidCron(c)).toThrow());
});
