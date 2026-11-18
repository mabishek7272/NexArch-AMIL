import { describe, expect, it } from 'vitest';
import { executeGraph, validateGraph, GraphNode } from './graph';

const n = (id: string, tpl = '{{input}}', extra: Partial<GraphNode> = {}): GraphNode => ({ id, skill: 'anuclaw-clinical', prompt_template: tpl, ...extra });

describe('validateGraph', () => {
  it('orders by dependencies, not array order', () => {
    const r = validateGraph([n('c', '{{b.output}}'), n('a'), n('b', '{{a.output}}')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]);
    expect(r.errors).toEqual([]);
    expect(r.order).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['cycle', [n('a'), n('b')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], /cycle/],
    ['unknown node edge', [n('a')], [{ from: 'a', to: 'zz' }], /unknown node/],
    ['self loop', [n('a')], [{ from: 'a', to: 'a' }], /self-loop/],
    ['duplicate id', [n('a'), n('a')], [], /duplicate node id/],
    ['duplicate edge', [n('a'), n('b')], [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }], /duplicate connection/],
    ['bad skill', [n('a', '', { skill: '../etc' })], [], /invalid skill/],
    ['non-upstream reference', [n('a'), n('b', '{{a.output}}')], [], /not upstream/],
    ['unknown reference', [n('a', '{{ghost.output}}')], [], /unknown node 'ghost'/],
    ['bad retries', [n('a', '', { retries: 9 })], [], /retries/],
  ])('rejects %s', (_l, nodes, edges, msg) => {
    const r = validateGraph(nodes, edges);
    expect(r.errors.join(' ')).toMatch(msg as RegExp);
  });
});

describe('executeGraph', () => {
  // a → b → d ; a → c (independent of b)
  const nodes = [n('a'), n('b', '{{a.output}}'), n('c', '{{a.output}}'), n('d', '{{b.output}}')];
  const edges = [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }];

  it('passes upstream outputs and succeeds when all nodes succeed', async () => {
    const seen: Record<string, Record<string, string>> = {};
    const r = await executeGraph(nodes, edges, async (node, up) => { seen[node.id] = up; return { text: `${node.id}-out` }; });
    expect(r.success).toBe(true);
    expect(seen.d).toEqual({ a: 'a-out', b: 'b-out' });
  });

  it('a returned error fails the node, skips its descendants, keeps independent branches, fails the run', async () => {
    const ran: string[] = [];
    const r = await executeGraph(nodes, edges, async (node) => {
      ran.push(node.id);
      return node.id === 'b' ? { text: '', error: 'provider_request_failed' } : { text: 'ok' };
    });
    expect(r.success).toBe(false);
    expect(r.outcomes.b).toMatchObject({ status: 'failed', error: 'provider_request_failed' });
    expect(r.outcomes.d.status).toBe('skipped_upstream_failed');
    expect(r.outcomes.c.status).toBe('succeeded');
    expect(ran).not.toContain('d'); // failed output never fed downstream
  });

  it('a thrown exception fails the node the same way', async () => {
    const r = await executeGraph([n('a'), n('b', '{{a.output}}')], [{ from: 'a', to: 'b' }], async (node) => {
      if (node.id === 'a') throw new Error('boom');
      return { text: 'x' };
    });
    expect(r.outcomes.a).toMatchObject({ status: 'failed', error: 'node_exception' });
    expect(r.outcomes.b.status).toBe('skipped_upstream_failed');
  });

  it('retries a failing node up to its bound', async () => {
    let calls = 0;
    const r = await executeGraph([n('a', '', { retries: 2 })], [], async () => (++calls < 3 ? { text: '', error: 'transient' } : { text: 'ok' }));
    expect(r.outcomes.a).toMatchObject({ status: 'succeeded', attempts: 3 });
  });

  it('refuses to execute an invalid graph', async () => {
    await expect(executeGraph([n('a'), n('b')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], async () => ({ text: '' }))).rejects.toThrow(/cycle/);
  });
});
