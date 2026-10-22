import { randomUUID } from 'node:crypto';
import type { AuditService } from '../../../common/audit/audit.service';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';

export interface AssignmentCommandActor {
  /** ERP user who runs the command (audit); null = server operator without an ERP account. */
  userId: string | null;
  correlationId: string;
}

export type AssignmentCohort = ReadonlySet<string> | null;

/**
 * Operator commands of the assignment channel (migration 270). They change the channel state under the same
 * advisory lock as the crm-sync relay (`bitrix24-live-writer`), so no write of the worker runs in between.
 */
export class Bitrix24AssignmentCommands {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** off → on. The release user takes over records that lose their manager; it must not have the «Свои» role. */
  async enable(actor: AssignmentCommandActor, releaseAssignedById: string): Promise<{ generation: number }> {
    if (!/^[1-9][0-9]*$/.test(releaseAssignedById)) {
      throw new AssignmentCommandError('BITRIX24_ASSIGNED_BY_ID must be set to the release user before enabling');
    }
    return this.locked(async (tx) => {
      const settings = await lockSettings(tx);
      if (settings.mode !== 'off') {
        throw new AssignmentCommandError(`channel is '${settings.mode}', enable needs 'off'`);
      }
      const generation = settings.generation + 1;
      await tx.query(
        `UPDATE bitrix24_assignment_settings
            SET mode='on', generation=$1, release_assigned_by_id=$2, updated_by=$3::bigint, updated_at=now()
          WHERE singleton`,
        [generation, releaseAssignedById, actor.userId],
      );
      await this.record(tx, actor, 'bitrix24.assignment.enabled', { generation, releaseAssignedById });
      return { generation };
    });
  }

  /** Read-only: what the cohort would take over (counts by source; no Bitrix24 call). */
  async plan(cohort: AssignmentCohort): Promise<Record<string, number>> {
    const users = cohort === null ? null : [...cohort].map(Number);
    const result = await this.db.query<{ key: string; count: string }>(
      `WITH mapped AS (
         SELECT mapping.erp_user_id, mapping.bitrix_user_id
           FROM bitrix24_user_mapping mapping
           JOIN users target ON target.user_id=mapping.erp_user_id
          WHERE mapping.is_active AND target.is_active AND NOT target.is_service_account
       ),
       orders_scope AS (
         SELECT o.order_id, o.client_id,
                CASE WHEN manager.erp_user_id IS NOT NULL THEN manager.erp_user_id ELSE author.erp_user_id END AS owner,
                CASE WHEN manager.erp_user_id IS NOT NULL THEN 'manager'
                     WHEN author.erp_user_id IS NOT NULL THEN 'created_by' ELSE 'unmapped' END AS source
           FROM orders o
           JOIN crm_sync_mapping deal ON deal.entity_type='order' AND deal.erp_id=o.order_id::text
                                     AND deal.status='active' AND deal.bitrix_id IS NOT NULL
           LEFT JOIN mapped manager ON manager.erp_user_id=o.manager_id
           LEFT JOIN mapped author ON author.erp_user_id=o.created_by
          WHERE o.delete_flag=false AND o.order_kind='production_order'
       )
       SELECT 'orders_' || source || CASE WHEN source <> 'unmapped' AND ($1::bigint[] IS NULL OR owner = ANY($1::bigint[]))
                                          THEN '_in_cohort' WHEN source <> 'unmapped' THEN '_outside_cohort' ELSE '' END AS key,
              count(*)::text AS count
         FROM orders_scope
        GROUP BY 1
       UNION ALL
       SELECT 'managed_' || bitrix_object, count(*)::text FROM bitrix24_assignment_remote
        WHERE managed AND retired_at IS NULL GROUP BY bitrix_object
       UNION ALL
       SELECT 'in_flight', count(*)::text FROM bitrix24_assignment_remote WHERE op_id IS NOT NULL
       UNION ALL
       SELECT 'mapped_users', count(*)::text FROM mapped`,
      [users],
    );
    return Object.fromEntries(result.rows.map((row) => [row.key, Number(row.count)]));
  }

  /**
   * Queues the cohort: production orders with a Bitrix24 deal whose manager or author is in it, their clients, and
   * clients the cohort wrote; plus every object ERP already owns (so records outside the cohort are released).
   * Batches of `batchSize`, each its own transaction with one sorted invalidation.
   */
  async enqueue(actor: AssignmentCommandActor, cohort: AssignmentCohort, batchSize = 500): Promise<{ touched: number }> {
    const settings = await this.db.query<{ mode: string }>(`SELECT mode FROM bitrix24_assignment_settings WHERE singleton`);
    if (settings.rows[0]?.mode !== 'on') throw new AssignmentCommandError('enqueue needs the channel in mode on');
    const users = cohort === null ? null : [...cohort].map(Number);
    const ref = `command:enqueue:${actor.correlationId}`;
    let touched = 0;
    let cursor = 0;
    for (;;) {
      const batch = await this.db.transaction(async (tx) => {
        const rows = await tx.query<{ order_id: string; client_id: string | null }>(
          `SELECT o.order_id, o.client_id
             FROM orders o
            WHERE o.order_id > $2::bigint AND o.delete_flag=false AND o.order_kind='production_order'
              AND ($1::bigint[] IS NULL OR o.manager_id = ANY($1::bigint[]) OR o.created_by = ANY($1::bigint[]))
              AND EXISTS (SELECT 1 FROM crm_sync_mapping deal
                           WHERE deal.entity_type='order' AND deal.erp_id=o.order_id::text AND deal.status='active')
            ORDER BY o.order_id
            LIMIT $3`,
          [users, cursor, batchSize],
        );
        if (rows.rows.length === 0) return null;
        const types: string[] = [];
        const ids: number[] = [];
        for (const row of rows.rows) {
          types.push('order');
          ids.push(Number(row.order_id));
          if (row.client_id !== null) {
            types.push('client');
            ids.push(Number(row.client_id));
          }
        }
        const count = await touch(tx, types, ids, ref, actor);
        return { count, last: Number(rows.rows[rows.rows.length - 1].order_id) };
      });
      if (!batch) break;
      touched += batch.count;
      cursor = batch.last;
    }
    // Clients with a Bitrix24 contact/company that the cohort wrote (all of them for «*»): a client without production
    // orders follows its author.
    let clientCursor = 0;
    for (;;) {
      const batch = await this.db.transaction(async (tx) => {
        const rows = await tx.query<{ client_id: string }>(
          `SELECT c.client_id::text AS client_id
             FROM clients c
            WHERE c.client_id > $2::bigint
              AND ($1::bigint[] IS NULL OR c.created_by = ANY($1::bigint[]))
              AND EXISTS (SELECT 1 FROM crm_sync_mapping m
                           WHERE m.entity_type='client' AND m.erp_id=c.client_id::text AND m.status='active')
            ORDER BY c.client_id
            LIMIT $3`,
          [users, clientCursor, batchSize],
        );
        if (rows.rows.length === 0) return null;
        const ids = rows.rows.map((row) => Number(row.client_id));
        const count = await touch(tx, ids.map(() => 'client'), ids, ref, actor);
        return { count, last: ids[ids.length - 1] };
      });
      if (!batch) break;
      touched += batch.count;
      clientCursor = batch.last;
    }
    // Everything ERP already owns: records whose manager left the cohort are released.
    touched += await this.db.transaction(async (tx) => {
      const rows = await tx.query<{ entity_type: string; erp_id: string }>(
        `SELECT DISTINCT entity_type, erp_id::text FROM bitrix24_assignment_remote WHERE managed AND retired_at IS NULL`,
      );
      return touch(tx, rows.rows.map((row) => row.entity_type), rows.rows.map((row) => Number(row.erp_id)), ref, actor);
    });
    return { touched };
  }

  /**
   * on → restore (new generation). Targets: every object ERP owns or has a write in flight on. ERP-owned objects go
   * back to the release user (what the ordinary sync wrote before the feature), Bitrix-owned ones to their baseline.
   */
  async startRestore(actor: AssignmentCommandActor, currentRelease: string | null): Promise<{ generation: number; targets: number }> {
    return this.locked(async (tx) => {
      const settings = await lockSettings(tx);
      if (settings.mode === 'off') throw new AssignmentCommandError('channel is off, nothing to restore');
      if (settings.release_assigned_by_id !== currentRelease) {
        throw new AssignmentCommandError(
          'BITRIX24_ASSIGNED_BY_ID differs from the channel release user: run set-release first (restore must end where the ordinary sync continues)',
        );
      }
      const generation = settings.generation + 1;
      await tx.query(
        `UPDATE bitrix24_assignment_settings SET mode='restore', generation=$1, updated_by=$2::bigint, updated_at=now()
          WHERE singleton`,
        [generation, actor.userId],
      );
      const targets = await tx.query<{ entity_type: string; erp_id: string }>(
        `UPDATE bitrix24_assignment_remote remote
            SET restore_generation=$1,
                restore_outcome='pending',
                restore_target=(
                  SELECT CASE WHEN mapping.source_system='bitrix24' THEN remote.original_assigned_by_id ELSE $2 END
                    FROM (SELECT 1) one
                    LEFT JOIN crm_sync_mapping mapping
                      ON mapping.entity_type=remote.entity_type AND mapping.erp_id=remote.erp_id::text
                ),
                updated_at=now()
          WHERE remote.managed OR remote.op_id IS NOT NULL
          RETURNING remote.entity_type, remote.erp_id::text AS erp_id`,
        [generation, settings.release_assigned_by_id],
      );
      const rows = [...new Map(targets.rows.map((row) => [`${row.entity_type}:${row.erp_id}`, row])).values()];
      await touch(tx, rows.map((row) => row.entity_type), rows.map((row) => Number(row.erp_id)), `command:restore:${actor.correlationId}`, actor);
      // Each target keeps the command's cause: its journal entry names who started the restore, whenever it is written.
      await tx.query(`UPDATE bitrix24_assignment_remote SET restore_cause_ids=NULL WHERE restore_generation=$1`, [generation]);
      const targetKeys = await tx.query<{ bitrix_object: string; bitrix_id: string }>(
        `SELECT bitrix_object, bitrix_id FROM bitrix24_assignment_remote WHERE restore_generation=$1`,
        [generation],
      );
      await attachRestoreCauses(tx, targetKeys.rows, `command:restore:${actor.correlationId}`);
      await this.record(tx, actor, 'bitrix24.assignment.restore_started', { generation, targets: targets.rowCount ?? 0 });
      return { generation, targets: targets.rowCount ?? 0 };
    });
  }

  /** Read-only preview of `restore`: targets and where they go, nothing is changed. */
  async previewRestore(currentRelease: string | null): Promise<Record<string, unknown>> {
    const settings = await this.db.query<{ mode: string; generation: number; release_assigned_by_id: string | null }>(
      `SELECT mode, generation, release_assigned_by_id FROM bitrix24_assignment_settings WHERE singleton`,
    );
    const row = settings.rows[0];
    const counts = await this.db.query<{ key: string; count: string }>(
      `SELECT CASE WHEN mapping.source_system='bitrix24' THEN 'to_original_bitrix_owned' ELSE 'to_release_user_erp_owned' END
              || CASE WHEN remote.op_id IS NOT NULL THEN '_in_flight' ELSE '' END AS key,
              count(*)::text AS count
         FROM bitrix24_assignment_remote remote
         LEFT JOIN crm_sync_mapping mapping
           ON mapping.entity_type=remote.entity_type AND mapping.erp_id=remote.erp_id::text
        WHERE remote.managed OR remote.op_id IS NOT NULL
        GROUP BY 1
       UNION ALL
       SELECT 'erp_owned_original_differs_from_release', count(*)::text
         FROM bitrix24_assignment_remote remote
         LEFT JOIN crm_sync_mapping mapping
           ON mapping.entity_type=remote.entity_type AND mapping.erp_id=remote.erp_id::text
        WHERE remote.managed AND COALESCE(mapping.source_system, 'erp') <> 'bitrix24'
          AND remote.original_assigned_by_id IS DISTINCT FROM $1`,
      [row?.release_assigned_by_id ?? null],
    );
    return {
      mode: row?.mode ?? 'off',
      generation: row?.generation ?? 0,
      releaseAssignedById: row?.release_assigned_by_id ?? null,
      configuredReleaseAssignedById: currentRelease,
      releaseMatches: (row?.release_assigned_by_id ?? null) === currentRelease,
      targets: Object.fromEntries(counts.rows.map((item) => [item.key, Number(item.count)])),
    };
  }

  /**
   * Adopts the configured release user (BITRIX24_ASSIGNED_BY_ID) after a configuration change. During a restore the
   * pending targets of ERP-owned objects move to it; every owned record is re-checked.
   */
  async setRelease(actor: AssignmentCommandActor, currentRelease: string | null): Promise<{ releaseAssignedById: string }> {
    if (currentRelease === null) throw new AssignmentCommandError('BITRIX24_ASSIGNED_BY_ID is not set');
    return this.locked(async (tx) => {
      const settings = await lockSettings(tx);
      if (settings.mode === 'off') throw new AssignmentCommandError('channel is off');
      let retargeted: { rows: Array<{ bitrix_object: string; bitrix_id: string }> } = { rows: [] };
      await tx.query(
        `UPDATE bitrix24_assignment_settings SET release_assigned_by_id=$1, updated_by=$2::bigint, updated_at=now() WHERE singleton`,
        [currentRelease, actor.userId],
      );
      if (settings.mode === 'restore') {
        // ERP-owned targets move to the new release user: pending and restored ones are written again, a preserved
        // conflict keeps waiting for its decision (an `apply` then writes the new user); explicit keeps stay.
        retargeted = await tx.query<{ bitrix_object: string; bitrix_id: string }>(
          `UPDATE bitrix24_assignment_remote remote
              SET restore_target=$2,
                  restore_outcome=CASE WHEN restore_outcome='conflict_preserved' THEN 'conflict_preserved' ELSE 'pending' END,
                  updated_at=now()
            WHERE restore_generation=$1 AND restore_outcome IN ('pending', 'restored', 'conflict_preserved')
              AND restore_target IS DISTINCT FROM $2
              AND COALESCE((SELECT mapping.source_system FROM crm_sync_mapping mapping
                             WHERE mapping.entity_type=remote.entity_type AND mapping.erp_id=remote.erp_id::text), 'erp') <> 'bitrix24'
            RETURNING bitrix_object, bitrix_id`,
          [settings.generation, currentRelease],
        );
      }
      const rows = await tx.query<{ entity_type: string; erp_id: string }>(
        `SELECT DISTINCT entity_type, erp_id::text FROM bitrix24_assignment_remote WHERE managed OR op_id IS NOT NULL`,
      );
      const ref = `command:set-release:${actor.correlationId}`;
      await touch(tx, rows.rows.map((item) => item.entity_type), rows.rows.map((item) => Number(item.erp_id)), ref, actor);
      await attachRestoreCauses(tx, retargeted.rows, ref);
      await this.record(tx, actor, 'bitrix24.assignment.release_changed', {
        before: settings.release_assigned_by_id,
        after: currentRelease,
        mode: settings.mode,
      });
      return { releaseAssignedById: currentRelease };
    });
  }

  /** A restore target changed by hand in Bitrix24: keep the hand-made value, or apply the restore target anyway. */
  async resolve(actor: AssignmentCommandActor, bitrixObject: string, bitrixId: string, decision: 'keep' | 'apply'): Promise<void> {
    await this.locked(async (tx) => {
      const settings = await lockSettings(tx);
      if (settings.mode !== 'restore') throw new AssignmentCommandError('resolve needs the channel in mode restore');
      const updated = await tx.query<{ entity_type: string; erp_id: string; sent_assigned_by_id: string | null }>(
        `UPDATE bitrix24_assignment_remote
            SET restore_outcome=CASE WHEN $4='keep' THEN 'kept' ELSE 'pending' END,
                -- apply: treat the hand-made value as ERP's last write so the restore writes over it.
                sent_assigned_by_id=CASE WHEN $4='apply' THEN observed_assigned_by_id ELSE sent_assigned_by_id END,
                updated_at=now()
          WHERE bitrix_object=$1 AND bitrix_id=$2 AND restore_generation=$3 AND restore_outcome='conflict_preserved'
          RETURNING entity_type, erp_id::text AS erp_id, sent_assigned_by_id`,
        [bitrixObject, bitrixId, settings.generation, decision],
      );
      if (updated.rowCount !== 1) throw new AssignmentCommandError('no preserved conflict for this object in the current restore');
      const row = updated.rows[0];
      if (decision === 'apply') {
        const ref = `command:resolve:${actor.correlationId}`;
        await touch(tx, [row.entity_type], [Number(row.erp_id)], ref, actor);
        await attachRestoreCauses(tx, [{ bitrix_object: bitrixObject, bitrix_id: bitrixId }], ref);
      }
      await this.record(tx, actor, 'bitrix24.assignment.restore_resolved', { bitrixObject, bitrixId, decision, generation: settings.generation });
    });
  }

  /**
   * restore → off, only when every target of the current generation is restored, verified missing or kept, and no
   * write is in flight anywhere. Returns what still blocks completion otherwise (the channel stays in restore).
   */
  async completeRestore(
    actor: AssignmentCommandActor,
    currentRelease: string | null,
  ): Promise<{ completed: boolean; blocking: Record<string, number> }> {
    return this.locked(async (tx) => {
      const settings = await lockSettings(tx);
      if (settings.mode !== 'restore') throw new AssignmentCommandError('complete needs the channel in mode restore');
      if (settings.release_assigned_by_id !== currentRelease) {
        throw new AssignmentCommandError(
          'BITRIX24_ASSIGNED_BY_ID differs from the channel release user: run set-release, let the restore finish, then complete',
        );
      }
      const blocking = await tx.query<{ key: string; count: string }>(
        `SELECT 'outcome_' || COALESCE(restore_outcome, 'none') AS key, count(*)::text AS count
           FROM bitrix24_assignment_remote
          WHERE (managed OR op_id IS NOT NULL OR restore_generation=$1)
            AND (restore_generation IS DISTINCT FROM $1 OR restore_outcome NOT IN ('restored', 'missing', 'kept'))
          GROUP BY 1
         UNION ALL
         SELECT 'in_flight', count(*)::text FROM bitrix24_assignment_remote WHERE op_id IS NOT NULL HAVING count(*) > 0
         UNION ALL
         SELECT 'fanout_open', count(*)::text FROM bitrix24_assignment_fanout WHERE phase <> 'done' HAVING count(*) > 0`,
        [settings.generation],
      );
      const counts = Object.fromEntries(blocking.rows.map((row) => [row.key, Number(row.count)]));
      if (Object.values(counts).some((count) => count > 0)) return { completed: false, blocking: counts };
      await tx.query(
        `UPDATE bitrix24_assignment_settings SET mode='off', updated_by=$1::bigint, updated_at=now() WHERE singleton`,
        [actor.userId],
      );
      // Remote rows stay as history; nothing is owned any more (the ordinary sync takes `assignedById` back).
      // The next activation captures a fresh baseline (Bitrix24 may change while the channel is off); the old values stay
      // in the change journal.
      await tx.query(
        `UPDATE bitrix24_assignment_remote
            SET managed=false, original_captured=false, original_assigned_by_id=NULL, enrolled_at=NULL, updated_at=now()
          WHERE managed OR original_captured`,
      );
      await tx.query(`UPDATE bitrix24_assignment_cause SET processed=true WHERE NOT processed`);
      await tx.query(`UPDATE bitrix24_assignment_entity SET lease_token=NULL, lease_until=NULL, updated_at=now()`);
      await this.record(tx, actor, 'bitrix24.assignment.restore_completed', { generation: settings.generation });
      return { completed: true, blocking: {} };
    });
  }

  async status(): Promise<Record<string, unknown>> {
    const settings = await this.db.query<{ mode: string; generation: number; release_assigned_by_id: string | null }>(
      `SELECT mode, generation, release_assigned_by_id FROM bitrix24_assignment_settings WHERE singleton`,
    );
    const counts = await this.db.query<{ key: string; count: string }>(
      `SELECT 'entities_pending' AS key, count(DISTINCT (entity_type, erp_id))::text AS count
         FROM bitrix24_assignment_cause WHERE NOT processed
       UNION ALL
       SELECT 'entities_error_' || last_error_code, count(*)::text FROM bitrix24_assignment_entity
        WHERE last_error_code IS NOT NULL GROUP BY last_error_code
       UNION ALL
       SELECT 'managed', count(*)::text FROM bitrix24_assignment_remote WHERE managed AND retired_at IS NULL
       UNION ALL
       SELECT 'in_flight', count(*)::text FROM bitrix24_assignment_remote WHERE op_id IS NOT NULL
       UNION ALL
       SELECT 'restore_' || restore_outcome, count(*)::text FROM bitrix24_assignment_remote
        WHERE restore_generation=(SELECT generation FROM bitrix24_assignment_settings WHERE singleton)
        GROUP BY restore_outcome
       UNION ALL
       SELECT 'changes_24h', count(*)::text FROM bitrix24_assignment_change WHERE created_at > now() - interval '24 hours'
       UNION ALL
       SELECT 'fanout_open', count(*)::text FROM bitrix24_assignment_fanout WHERE phase <> 'done'`,
    );
    const conflicts = await this.db.query<{ bitrix_object: string; bitrix_id: string; entity_type: string; erp_id: string }>(
      `SELECT bitrix_object, bitrix_id, entity_type, erp_id::text AS erp_id FROM bitrix24_assignment_remote
        WHERE restore_outcome='conflict_preserved'
          AND restore_generation=(SELECT generation FROM bitrix24_assignment_settings WHERE singleton)
        ORDER BY bitrix_object, bitrix_id LIMIT 100`,
    );
    return {
      mode: settings.rows[0]?.mode ?? 'off',
      generation: settings.rows[0]?.generation ?? 0,
      releaseAssignedById: settings.rows[0]?.release_assigned_by_id ?? null,
      counts: Object.fromEntries(counts.rows.map((row) => [row.key, Number(row.count)])),
      conflicts: conflicts.rows.map((row) => `${row.bitrix_object}:${row.bitrix_id} (${row.entity_type} ${row.erp_id})`),
    };
  }

  private async locked<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
    const result = await this.db.withAdvisoryLock('bitrix24-live-writer', async () => ({ value: await this.db.transaction(handler) }));
    if (result === null) {
      throw new AssignmentCommandError('the crm-sync writer is busy, try again in a minute');
    }
    return result.value;
  }

  private async record(tx: TransactionClient, actor: AssignmentCommandActor, event: string, metadata: Record<string, unknown>): Promise<void> {
    await this.audit.record(tx, {
      event,
      entityType: 'bitrix24_assignment',
      entityId: 1,
      actorUserId: actor.userId,
      requestId: actor.correlationId,
      source: 'crm-sync-assignment',
      metadata,
    });
  }
}

export class AssignmentCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssignmentCommandError';
  }
}

export function newCorrelationId(): string {
  return `bitrix24-assignment-cli:${randomUUID()}`;
}

async function lockSettings(tx: TransactionClient): Promise<{ mode: string; generation: number; release_assigned_by_id: string | null }> {
  const result = await tx.query<{ mode: string; generation: number; release_assigned_by_id: string | null }>(
    `SELECT mode, generation, release_assigned_by_id FROM bitrix24_assignment_settings WHERE singleton FOR UPDATE`,
  );
  const row = result.rows[0];
  if (!row) throw new AssignmentCommandError('migration 270 is not applied');
  return { ...row, generation: Number(row.generation) };
}

/** Appends the causes a command wrote (by its ref) to the given restore targets: their journal names that command. */
async function attachRestoreCauses(
  tx: TransactionClient,
  targets: ReadonlyArray<{ bitrix_object: string; bitrix_id: string }>,
  ref: string,
): Promise<void> {
  if (targets.length === 0) return;
  await tx.query(
    `UPDATE bitrix24_assignment_remote remote
        SET restore_cause_ids=COALESCE(remote.restore_cause_ids, '{}') || ARRAY(
              SELECT cause.cause_id FROM bitrix24_assignment_cause cause
               WHERE cause.entity_type=remote.entity_type AND cause.erp_id=remote.erp_id AND cause.ref_id=$3
               ORDER BY cause.cause_id),
            updated_at=now()
       FROM unnest($1::text[], $2::text[]) AS target(bitrix_object, bitrix_id)
      WHERE remote.bitrix_object=target.bitrix_object AND remote.bitrix_id=target.bitrix_id`,
    [targets.map((target) => target.bitrix_object), targets.map((target) => target.bitrix_id), ref],
  );
}

async function touch(
  tx: TransactionClient,
  types: string[],
  ids: number[],
  ref: string,
  actor: AssignmentCommandActor,
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await tx.query<{ touched: number }>(
    `SELECT bitrix24_assignment_touch($1::text[], $2::bigint[], 'command', $3, $4::bigint, $5) AS touched`,
    [types, ids, ref, actor.userId, actor.correlationId],
  );
  return Number(result.rows[0]?.touched ?? 0);
}
