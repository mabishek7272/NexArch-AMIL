/**
 * Pipeline graph validation and execution (plan F08).
 *
 * - Validation: unique ids, valid skill names, edges reference existing nodes, no
 *   self-loops/duplicates, ACYCLIC, and every `{{<nodeId>.output}}` reference
 *   points at an upstream (ancestor) node.
 * - Execution: deterministic topological order (ties broken by node order).
 *   A node whose run returns `error` (or throws) is FAILED; its descendants are
 *   SKIPPED (never fed a failed output); independent branches still run. The run
 *   succeeds only if every node succeeded. Optional bounded per-node retries.
 */

export interface GraphNode { id: string; skill: string; label?: string; prompt_template: string; retries?: number }
export interface GraphEdge { from: string; to: string }

export type NodeStatus = 'succeeded' | 'failed' | 'skipped_upstream_failed';
export interface NodeOutcome { status: NodeStatus; output?: string; error?: string; attempts: number; executionMode?: string }

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SKILL = /^[a-z0-9-]{1,100}$/;
const REF = /\{\{([A-Za-z0-9_-]+)\.output\}\}/g;
export const MAX_NODES = 50;
export const MAX_RETRIES = 2;

export function referencedNodes(template: string): string[] {
  return [...template.matchAll(REF)].map((m) => m[1]);
}

/** Returns a list of problems (empty = valid) and, if valid, the execution order. */
export function validateGraph(nodes: unknown, edges: unknown): { errors: string[]; order: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(nodes) || nodes.length === 0) return { errors: ['nodes must be a non-empty array'], order: [] };
  if (nodes.length > MAX_NODES) return { errors: [`at most ${MAX_NODES} nodes`], order: [] };
  const list = Array.isArray(edges) ? (edges as GraphEdge[]) : edges === undefined ? [] : null;
  if (list === null) return { errors: ['connections must be an array'], order: [] };

  const ids = new Set<string>();
  for (const [i, n] of (nodes as GraphNode[]).entries()) {
    if (!n || typeof n !== 'object') { errors.push(`node ${i} is not an object`); continue; }
    if (typeof n.id !== 'string' || !ID.test(n.id)) errors.push(`node ${i}: invalid id`);
    else if (ids.has(n.id)) errors.push(`duplicate node id '${n.id}'`);
    else ids.add(n.id);
    if (typeof n.skill !== 'string' || !SKILL.test(n.skill)) errors.push(`node ${n.id ?? i}: invalid skill`);
    if (typeof n.prompt_template !== 'string') errors.push(`node ${n.id ?? i}: prompt_template must be a string`);
    if (n.retries !== undefined && !(Number.isInteger(n.retries) && n.retries >= 0 && n.retries <= MAX_RETRIES)) {
      errors.push(`node ${n.id ?? i}: retries must be 0..${MAX_RETRIES}`);
    }
  }
  const seen = new Set<string>();
  for (const e of list) {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') { errors.push('invalid connection'); continue; }
    if (!ids.has(e.from) || !ids.has(e.to)) errors.push(`connection ${e.from}→${e.to} references an unknown node`);
    if (e.from === e.to) errors.push(`self-loop on '${e.from}'`);
    const k = `${e.from}\u0000${e.to}`;
    if (seen.has(k)) errors.push(`duplicate connection ${e.from}→${e.to}`);
    seen.add(k);
  }
  if (errors.length) return { errors, order: [] };

  const order = topoOrder(nodes as GraphNode[], list);
  if (!order) return { errors: ['connections contain a cycle'], order: [] };

  const anc = ancestors(nodes as GraphNode[], list);
  for (const n of nodes as GraphNode[]) {
    for (const ref of referencedNodes(n.prompt_template)) {
      if (!ids.has(ref)) errors.push(`node ${n.id} references unknown node '${ref}'`);
      else if (!anc.get(n.id)!.has(ref)) errors.push(`node ${n.id} references '${ref}', which is not upstream of it`);
    }
  }
  return errors.length ? { errors, order: [] } : { errors, order };
}

function topoOrder(nodes: GraphNode[], edges: GraphEdge[]): string[] | null {
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const out = new Map(nodes.map((n) => [n.id, [] as string[]]));
  for (const e of edges) { indeg.set(e.to, indeg.get(e.to)! + 1); out.get(e.from)!.push(e.to); }
  const pos = new Map(nodes.map((n, i) => [n.id, i]));
  const ready = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => pos.get(a)! - pos.get(b)!);
    const id = ready.shift()!;
    order.push(id);
    for (const t of out.get(id)!) { indeg.set(t, indeg.get(t)! - 1); if (indeg.get(t) === 0) ready.push(t); }
  }
  return order.length === nodes.length ? order : null;
}

function ancestors(nodes: GraphNode[], edges: GraphEdge[]): Map<string, Set<string>> {
  const parents = new Map(nodes.map((n) => [n.id, [] as string[]]));
  for (const e of edges) parents.get(e.to)!.push(e.from);
  const memo = new Map<string, Set<string>>();
  const visit = (id: string): Set<string> => {
    if (memo.has(id)) return memo.get(id)!;
    const s = new Set<string>();
    memo.set(id, s);
    for (const p of parents.get(id)!) { s.add(p); for (const a of visit(p)) s.add(a); }
    return s;
  };
  for (const n of nodes) visit(n.id);
  return memo;
}

export interface RunNodeResult { text: string; error?: string; executionMode?: string }

export async function executeGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  runNode: (node: GraphNode, upstreamOutputs: Record<string, string>) => Promise<RunNodeResult>,
  hooks: { onStart?: (n: GraphNode) => void; onDone?: (n: GraphNode, o: NodeOutcome) => void } = {},
): Promise<{ success: boolean; outcomes: Record<string, NodeOutcome>; order: string[] }> {
  const { errors, order } = validateGraph(nodes, edges);
  if (errors.length) throw new Error(`invalid pipeline graph: ${errors.join('; ')}`);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const anc = ancestors(nodes, edges);
  const outcomes: Record<string, NodeOutcome> = {};

  for (const id of order) {
    const node = byId.get(id)!;
    const blocked = [...anc.get(id)!].some((a) => outcomes[a]?.status !== 'succeeded');
    if (blocked) {
      outcomes[id] = { status: 'skipped_upstream_failed', attempts: 0 };
      hooks.onDone?.(node, outcomes[id]);
      continue;
    }
    hooks.onStart?.(node);
    const upstream: Record<string, string> = {};
    for (const a of anc.get(id)!) upstream[a] = outcomes[a].output ?? '';
    const maxAttempts = 1 + (node.retries ?? 0);
    let last: NodeOutcome = { status: 'failed', attempts: 0, error: 'not_run' };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const r = await runNode(node, upstream);
        last = r.error
          ? { status: 'failed', error: r.error, attempts: attempt, executionMode: r.executionMode }
          : { status: 'succeeded', output: r.text, attempts: attempt, executionMode: r.executionMode };
      } catch (err) {
        last = { status: 'failed', error: 'node_exception', attempts: attempt };
        void err;
      }
      if (last.status === 'succeeded') break;
    }
    outcomes[id] = last;
    hooks.onDone?.(node, last);
  }
  return { success: order.every((id) => outcomes[id].status === 'succeeded'), outcomes, order };
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z0-9_-]+(?:\.output)?)\}\}/g, (_, key) => vars[key] ?? `[${key} not available]`);
}
