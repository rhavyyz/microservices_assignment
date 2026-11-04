import type { Queryable } from './pool.ts';

/**
 * Builds and runs `UPDATE <table> SET <changed columns>, updated_at = now() WHERE id = $n RETURNING *`.
 * Only keys listed in `columns` are written; they come from code, never from the request, so the
 * interpolated identifiers are safe. Keys whose value is undefined are left untouched (partial update).
 */
export async function updateColumns<Row>(
  q: Queryable,
  table: string,
  id: string,
  patch: Record<string, unknown>,
  columns: readonly string[],
): Promise<Row> {
  const changed = columns.filter((c) => patch[c] !== undefined);
  const sets = changed.map((c, i) => `${c} = $${i + 1}`);
  const values = changed.map((c) => patch[c]);
  const res = await q.query(
    `UPDATE ${table} SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $${changed.length + 1} RETURNING *`,
    [...values, id],
  );
  return res.rows[0] as Row;
}

/** Builds `INSERT INTO <table> (<keys>) VALUES ($1..$n) RETURNING *` from a record whose keys are columns. */
export async function insertRow<Row>(q: Queryable, table: string, row: Record<string, unknown>): Promise<Row> {
  const keys = Object.keys(row);
  const res = await q.query(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => row[k]),
  );
  return res.rows[0] as Row;
}

/** `FOR UPDATE` suffix when the caller is going to change the row inside its transaction. */
export const lockClause = (forUpdate: boolean | undefined) => (forUpdate ? ' FOR UPDATE' : '');
