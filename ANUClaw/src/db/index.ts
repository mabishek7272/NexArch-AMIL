import { getDb } from './connection';

export { getDb, ensureDbReady } from './connection';

/** A query handle bound to one transaction's connection. */
export interface TxClient {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }>;
}

export const db = {
  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const pool = getDb();
    const res = await pool.query(sql, params);
    return res.rows;
  },

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | undefined> {
    const pool = getDb();
    const res = await pool.query(sql, params);
    return res.rows[0];
  },

  /**
   * Run `fn` inside BEGIN/COMMIT on a single pooled connection; ROLLBACK on any
   * throw. Use for multi-statement invariants and row locks (FOR SHARE/UPDATE).
   */
  async transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    const client = await getDb().connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        query: async (sql, params) => {
          const r = await client.query(sql, params);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be broken */ }
      throw err;
    } finally {
      client.release();
    }
  },
};
