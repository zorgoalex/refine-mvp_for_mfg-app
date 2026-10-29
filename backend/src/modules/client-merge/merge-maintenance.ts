import type { DatabaseService } from '../../database/database.service';
import { PERSONAL_ITEM_KINDS } from './client-merge';

const ALIGN_LIMIT = 5_000;

/**
 * The client of a deadline of an order (and of its events) is a copy of the order's client. After a merge or an undo the
 * copies are aligned one row per transaction: the row `FOR UPDATE SKIP LOCKED`, then an ordinary read of the order — the
 * transaction never holds more than one deadline row and takes no lock after the order, so it cannot meet the deadline
 * worker (event → order) in a cycle. A row the worker holds is skipped and aligned by the next pass. `orderIds = null` —
 * every row whose copy differs (the maintenance).
 */
export async function alignDeadlines(database: DatabaseService, orderIds: number[] | null): Promise<number> {
  let aligned = 0;
  for (const table of ['deadline_instances', 'deadline_events'] as const) {
    const id = table === 'deadline_instances' ? 'deadline_id' : 'deadline_event_id';
    const seen = new Set<string>();
    while (aligned < ALIGN_LIMIT) {
      const done = await database.transaction(async (tx) => {
        const row = (await tx.query<{ id: string }>(
          `SELECT d.${id}::text AS id FROM ${table} d JOIN orders o ON o.order_id = d.order_id
            WHERE d.client_id IS DISTINCT FROM o.client_id ${orderIds ? 'AND d.order_id = ANY($1::bigint[])' : ''}
              AND NOT (d.${id}::text = ANY($${orderIds ? 2 : 1}::text[]))
            ORDER BY d.${id} LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, orderIds ? [orderIds, [...seen]] : [[...seen]])).rows[0];
        if (!row) return false;
        seen.add(row.id);
        await tx.query(
          `UPDATE ${table} d SET client_id = (SELECT o.client_id FROM orders o WHERE o.order_id = d.order_id) WHERE d.${id}::text = $1`, [row.id]);
        return true;
      });
      if (!done) break;
      aligned += 1;
    }
  }
  return aligned;
}

/** After the undo term the personal data of a journal (numbers, contact values, notes) is erased; the merge can no longer be undone. */
export async function purgeJournals(database: DatabaseService): Promise<number> {
  return database.transaction(async (tx) => {
    const ids = (await tx.query<{ merge_id: string }>(
      `SELECT merge_id FROM client_merges WHERE journal_purged_at IS NULL AND undo_until <= now() ORDER BY merge_id LIMIT 500 FOR UPDATE SKIP LOCKED`)).rows
      .map((r) => Number(r.merge_id));
    if (!ids.length) return 0;
    await tx.query(
      `UPDATE client_merge_items SET before = CASE WHEN before IS NULL THEN NULL ELSE '{"purged": true}'::jsonb END,
              after = CASE WHEN after IS NULL THEN NULL ELSE '{"purged": true}'::jsonb END
        WHERE merge_id = ANY($1::bigint[]) AND item_kind = ANY($2::text[])`, [ids, PERSONAL_ITEM_KINDS]);
    await tx.query('UPDATE client_merges SET journal_purged_at = now() WHERE merge_id = ANY($1::bigint[])', [ids]);
    return ids.length;
  });
}
