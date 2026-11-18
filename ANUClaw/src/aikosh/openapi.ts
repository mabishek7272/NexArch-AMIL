import { AIKOSH_NOTICE } from '../dashboard/server/routes/aikosh';
export const AIKOSH_OPS = [
  { method: 'get', path: '/', summary: 'Registry view: every inventoried file with its default status "unknown — blocked from external processing", personal-data indicators (heuristic), restricted fields and any approvals' },
  { method: 'post', path: '/sync', summary: 'Register the generated inventory (immutable rows keyed by path + SHA-256); admin or compliance only' },
  { method: 'post', path: '/approvals', summary: 'Record an approval PROPOSAL: provenance, licence, permitted uses, sensitivity, consent/de-identification/DPA references. Admin or compliance only. Grants nothing until a different person approves' },
  { method: 'post', path: '/approvals/{id}/decision', summary: 'Approve or revoke a record. Approval must come from a different admin/compliance user than the recorder; the decision log is append-only and hash-chained; a revoked record cannot be revived' },
  { method: 'get', path: '/approvals/{id}/chain', summary: 'Verify the hash chain of the decisions for a record' },
  { method: 'get', path: '/check', summary: 'Evaluate whether a use (rag, embeddings, model_prompt, fine_tuning, clinical_evidence, external_provider, local_*) is allowed for a file and fields, with reasons' },
] as const;
export function buildAikoshOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const o of AIKOSH_OPS) (paths[o.path] ??= {})[o.method] = { summary: o.summary, description: AIKOSH_NOTICE, security: [{ DashboardSession: [] }, { Bearer: [] }],
    ...(o.path.includes('{id}') ? { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } : {}),
    ...(o.path === '/check' ? { parameters: [{ name: 'path', in: 'query', required: true, schema: { type: 'string' } }, { name: 'use', in: 'query', required: true, schema: { type: 'string' } }, { name: 'fields', in: 'query', schema: { type: 'string' } }] } : {}),
    responses: { 200: { description: 'OK' }, 201: { description: 'Created' }, 400: { description: 'Bad input / forbidden_field / incomplete_approval' }, 401: { description: 'Not authenticated' }, 403: { description: 'Role or second-person rule' }, 404: { description: 'Not found' }, 409: { description: 'State conflict' } } };
  return { openapi: '3.1.0', info: { title: 'ANUClaw AIKosh data registry API', version: '1.0.0', description: AIKOSH_NOTICE }, servers: [{ url: 'http://127.0.0.1:4100/api/aikosh' }],
    components: { securitySchemes: { DashboardSession: { type: 'apiKey', in: 'cookie', name: 'dash_token' }, Bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } }, paths };
}
