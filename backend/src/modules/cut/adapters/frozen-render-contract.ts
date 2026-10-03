import type { DatabaseClient } from '../../../database/database.types';

/**
 * Which frozen render contract new cut results are saved with. `cut_settings` row
 * `render.snapshot_contract` = `{"contract":"v1"}` switches both writers back to the twelve stored
 * views without a deploy (the rollback point of contract v2); no row = v2. Readers accept both.
 */
export const RENDER_SNAPSHOT_CONTRACT_SETTING_KEY = 'render.snapshot_contract';
export type RenderSnapshotContract = 'v1' | 'v2';

export async function readRenderSnapshotContract(client: DatabaseClient): Promise<RenderSnapshotContract> {
  const result = await client.query<{ value: unknown }>(
    `SELECT value FROM cut_settings WHERE key = $1 LIMIT 1`,
    [RENDER_SNAPSHOT_CONTRACT_SETTING_KEY],
  );
  if (result.rows.length === 0) return 'v2';
  const value = result.rows[0].value as { contract?: unknown } | null;
  // Anything but an explicit v2 keeps the full legacy snapshot: never lose views on a typo.
  return value?.contract === 'v2' ? 'v2' : 'v1';
}
