import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '../database/database.types';
import { lockAuthorizationState } from './authorization-command-guard';

/**
 * The revert barrier of the Hasura step F2 (finances plan 2026-10-17 §2.3) on a real PostgreSQL with migration 258
 * (AUTHORIZATION_INTEGRATION_DATABASE_URL — a scratch database, never stage or prod). The revert takes
 * permissions_state FOR UPDATE, checks who lost the money right and sets `reverting`; an authorization command that was
 * waiting for that lock must see `reverting` and refuse — it may not slip in between the check and the restore.
 */
const databaseUrl = process.env.AUTHORIZATION_INTEGRATION_DATABASE_URL;
const maybe = databaseUrl ? describe : describe.skip;

maybe('authorization changes during a revert of the Hasura step F2', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 4, statement_timeout: 15000 });
  });

  afterAll(async () => {
    await pool.query("UPDATE permissions_state SET hasura_financials_state = 'open' WHERE id = true");
    await pool?.end();
  });

  it('a command waiting for the lock while the revert sets `reverting` is refused with 409 after the lock', async () => {
    await pool.query("UPDATE permissions_state SET hasura_financials_state = 'closed' WHERE id = true");
    const revert = await pool.connect();
    const command = await pool.connect();
    try {
      await revert.query('BEGIN');
      await revert.query('SELECT version FROM permissions_state WHERE id = true FOR UPDATE');

      await command.query('BEGIN');
      const waiting = lockAuthorizationState(command as unknown as DatabaseClient, 'update').then(
        () => 'locked',
        (error: { statusCode?: number; code?: string }) => `${error.statusCode} ${error.code}`,
      );
      // The command is now blocked on the row lock held by the revert.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await revert.query("UPDATE permissions_state SET hasura_financials_state = 'reverting' WHERE id = true");
      await revert.query('COMMIT');

      expect(await waiting).toBe('409 AUTHORIZATION_CHANGES_PAUSED');
      await command.query('ROLLBACK');
    } finally {
      revert.release();
      command.release();
    }
  });

  it('once the revert finished (`open`) the same command goes through', async () => {
    await pool.query("UPDATE permissions_state SET hasura_financials_state = 'open' WHERE id = true");
    const command = await pool.connect();
    try {
      await command.query('BEGIN');
      await expect(lockAuthorizationState(command as unknown as DatabaseClient, 'update')).resolves.toBeGreaterThan(0);
      await command.query('ROLLBACK');
    } finally {
      command.release();
    }
  });
});
