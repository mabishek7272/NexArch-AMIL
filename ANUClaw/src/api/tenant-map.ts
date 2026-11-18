/**
 * Pure tenant-row mapping (no DB import — hermetically testable).
 *
 * The E-LAB tiering columns `scopes` and `allowed_clinical_domains` are stored as
 * JSON text; this parses them back to arrays when a tenant row is loaded.
 */

import type { Tenant } from './tenant-store';

function parseJsonArray(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value as string[];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? (parsed as string[]) : undefined;
  } catch {
    return undefined;
  }
}

export function mapTenantRow(row: Record<string, unknown>): Tenant {
  // Never surface stored key material (placeholder/hash) on tenant objects.
  const { api_key_hash: _h, api_key: _k, ...safe } = row as Record<string, unknown>;
  return {
    ...(safe as unknown as Tenant),
    api_key: '',
    scopes: parseJsonArray(row.scopes),
    allowed_clinical_domains: parseJsonArray(row.allowed_clinical_domains),
  };
}
