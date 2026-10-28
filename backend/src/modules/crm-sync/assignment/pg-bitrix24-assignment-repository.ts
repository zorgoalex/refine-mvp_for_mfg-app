import { randomUUID } from 'node:crypto';
import type { AuditService } from '../../../common/audit/audit.service';
import type { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';

export type AssignmentEntityType = 'order' | 'client';
export type AssignmentObject = 'deal' | 'contact' | 'company';
export type AssignmentMode = 'off' | 'on' | 'restore';
export type AssignmentPurpose = 'assign' | 'release' | 'restore';
export type DesiredSource = 'manager' | 'created_by' | 'client_latest_order' | 'client_creator';
export type RestoreOutcome = 'pending' | 'restored' | 'missing' | 'conflict_preserved' | 'kept';

export interface AssignmentSettings {
  mode: AssignmentMode;
  generation: number;
  releaseAssignedById: string | null;
}

export interface ClaimedAssignmentEntity {
  entityType: AssignmentEntityType;
  erpId: string;
  /** Highest open cause the claim saw (0 = only in-flight or restore work). */
  version: number;
  /** Exactly the open causes the claim saw: only these are closed by its outcome. */
  causeIds: number[];
  processedVersion: number;
  attempts: number;
  leaseToken: string;
}

export interface AssignmentRemote {
  bitrixObject: AssignmentObject;
  bitrixId: string;
  entityType: AssignmentEntityType;
  erpId: string;
  managed: boolean;
  originalCaptured: boolean;
  originalAssignedById: string | null;
  sentAssignedById: string | null;
  opId: string | null;
  opTarget: string | null;
  opBefore: string | null;
  opEntityVersion: number | null;
  opCauseIds: number[] | null;
  opDesiredSource: string | null;
  opDesiredOrderId: string | null;
  opGeneration: number | null;
  opPurpose: AssignmentPurpose | null;
  restoreGeneration: number | null;
  restoreTarget: string | null;
  restoreCauseIds: number[] | null;
  restoreOutcome: RestoreOutcome | null;
  retiredAt: Date | null;
}

export interface CurrentCrmObject {
  bitrixObject: AssignmentObject;
  bitrixId: string;
  sourceSystem: 'erp' | 'bitrix24';
}

export interface DesiredAssignment {
  bitrixUserId: string;
  erpUserId: string;
  source: DesiredSource;
  /** The order that decided a client's responsible user. */
  orderId: string | null;
}

export interface FinalizeInput {
  remote: AssignmentRemote;
  opId: string;
}

const ENTITY_TYPES = new Set(['order', 'client']);

/**
 * Storage of the Bitrix24 assignment channel (migration 270). Every write of the worker is fenced: entity rows by the
 * lease token of the claim, remote rows by `op_id`.
 */
export class PgBitrix24AssignmentRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async settings(client: DatabaseClient = this.db): Promise<AssignmentSettings> {
    const result = await client.query<{ mode: AssignmentMode; generation: number; release_assigned_by_id: string | null }>(
      `SELECT mode, generation, release_assigned_by_id FROM bitrix24_assignment_settings WHERE singleton`,
    );
    const row = result.rows[0];
    return row
      ? { mode: row.mode, generation: Number(row.generation), releaseAssignedById: row.release_assigned_by_id }
      : { mode: 'off', generation: 0, releaseAssignedById: null };
  }

  async ownsAssignment(entityType: AssignmentEntityType, erpId: string): Promise<boolean> {
    return assignmentOwnership(this.db).ownsAssignment(entityType, erpId);
  }

  /**
   * Entities with work: open causes, a write in flight, or a pending restore target of the current generation. Retries
   * wait for `next_attempt_at`, but a cause newer than what the last claim saw makes the entity due at once. Entity
   * rows are created here (the worker is their only writer).
   */
  async claimDue(limit: number, leaseMs: number): Promise<ClaimedAssignmentEntity[]> {
    const token = randomUUID();
    return this.db.transaction(async (tx) => {
      const due = await tx.query<{ entity_type: AssignmentEntityType; erp_id: string; top: string }>(
        `WITH settings AS (
           SELECT mode, generation FROM bitrix24_assignment_settings WHERE singleton
         ), work AS (
           SELECT entity_type, erp_id, max(cause_id) AS top
             FROM bitrix24_assignment_cause WHERE NOT processed GROUP BY entity_type, erp_id
           UNION ALL
           SELECT entity_type, erp_id, 0 FROM bitrix24_assignment_remote WHERE op_id IS NOT NULL
           UNION ALL
           SELECT remote.entity_type, remote.erp_id, 0
             FROM bitrix24_assignment_remote remote, settings
            WHERE settings.mode='restore' AND remote.restore_generation=settings.generation
              AND remote.restore_outcome='pending'
         ), grouped AS (
           SELECT entity_type, erp_id, max(top) AS top FROM work GROUP BY entity_type, erp_id
         )
         SELECT grouped.entity_type, grouped.erp_id::text AS erp_id, grouped.top::text AS top
           FROM grouped
           LEFT JOIN bitrix24_assignment_entity entity
             ON entity.entity_type=grouped.entity_type AND entity.erp_id=grouped.erp_id
          WHERE (entity.lease_until IS NULL OR entity.lease_until < now())
            AND (entity.erp_id IS NULL OR entity.next_attempt_at <= now() OR grouped.top > entity.seen_cause_id)
          ORDER BY COALESCE(entity.next_attempt_at, '-infinity'::timestamptz), grouped.entity_type, grouped.erp_id
          LIMIT $1`,
        [limit],
      );
      if (due.rows.length === 0) return [];
      await tx.query(
        `INSERT INTO bitrix24_assignment_entity (entity_type, erp_id)
         SELECT entity_type, erp_id::bigint FROM unnest($1::text[], $2::text[]) AS due(entity_type, erp_id)
         ON CONFLICT (entity_type, erp_id) DO NOTHING`,
        [due.rows.map((row) => row.entity_type), due.rows.map((row) => row.erp_id)],
      );
      const claimed = await tx.query<{
        entity_type: AssignmentEntityType;
        erp_id: string;
        top: string;
        processed_cause_id: string;
        attempts: number;
      }>(
        `UPDATE bitrix24_assignment_entity entity
            SET lease_token=$1, lease_until=now() + ($2::integer * interval '1 millisecond'),
                seen_cause_id=GREATEST(entity.seen_cause_id, due.top), updated_at=now()
           FROM unnest($3::text[], $4::text[], $5::bigint[]) AS due(entity_type, erp_id, top)
          WHERE entity.entity_type=due.entity_type AND entity.erp_id=due.erp_id::bigint
            AND (entity.lease_until IS NULL OR entity.lease_until < now())
          RETURNING entity.entity_type, entity.erp_id::text AS erp_id, due.top::text AS top,
                    entity.processed_cause_id::text AS processed_cause_id, entity.attempts`,
        [
          token,
          leaseMs,
          due.rows.map((row) => row.entity_type),
          due.rows.map((row) => row.erp_id),
          due.rows.map((row) => row.top),
        ],
      );
      const open = await tx.query<{ entity_type: string; erp_id: string; ids: string[] }>(
        `SELECT entity_type, erp_id::text AS erp_id, array_agg(cause_id ORDER BY cause_id)::text[] AS ids
           FROM bitrix24_assignment_cause
          WHERE NOT processed
            AND (entity_type, erp_id) IN (SELECT * FROM unnest($1::text[], $2::bigint[]))
          GROUP BY entity_type, erp_id`,
        [claimed.rows.map((row) => row.entity_type), claimed.rows.map((row) => row.erp_id)],
      );
      const causes = new Map(open.rows.map((row) => [`${row.entity_type}:${row.erp_id}`, row.ids.map(Number)]));
      return claimed.rows.map((row) => ({
        entityType: row.entity_type,
        erpId: row.erp_id,
        causeIds: causes.get(`${row.entity_type}:${row.erp_id}`) ?? [],
        version: Number(row.top),
        processedVersion: Number(row.processed_cause_id),
        attempts: Number(row.attempts),
        leaseToken: token,
      }));
    });
  }

  async remotes(entity: ClaimedAssignmentEntity): Promise<AssignmentRemote[]> {
    const result = await this.db.query<RemoteRow>(
      `${REMOTE_SELECT} WHERE entity_type=$1 AND erp_id=$2::bigint ORDER BY created_at, bitrix_object, bitrix_id`,
      [entity.entityType, entity.erpId],
    );
    return result.rows.map(toRemote);
  }

  async remote(bitrixObject: AssignmentObject, bitrixId: string): Promise<AssignmentRemote | null> {
    const result = await this.db.query<RemoteRow>(
      `${REMOTE_SELECT} WHERE bitrix_object=$1 AND bitrix_id=$2`,
      [bitrixObject, bitrixId],
    );
    return result.rows[0] ? toRemote(result.rows[0]) : null;
  }

  /** The active CRM object of the entity (a deal for an order, a contact or a company for a client). */
  async currentObject(entityType: AssignmentEntityType, erpId: string): Promise<CurrentCrmObject | null> {
    const result = await this.db.query<{ bitrix_object: AssignmentObject; bitrix_id: string; source_system: 'erp' | 'bitrix24' }>(
      `SELECT bitrix_object, bitrix_id, source_system
         FROM crm_sync_mapping
        WHERE entity_type=$1 AND erp_id=$2::text AND status='active' AND bitrix_id IS NOT NULL
          AND bitrix_object = ANY($3::text[])`,
      [entityType, erpId, entityType === 'order' ? ['deal'] : ['contact', 'company']],
    );
    const row = result.rows[0];
    return row ? { bitrixObject: row.bitrix_object, bitrixId: row.bitrix_id, sourceSystem: row.source_system } : null;
  }

  /** Registers the current object of the entity and retires its other objects (a contact replaced by a company). */
  async ensureRemote(entity: ClaimedAssignmentEntity, current: CurrentCrmObject): Promise<AssignmentRemote> {
    return this.db.transaction(async (tx) => {
      await this.assertLease(tx, entity);
      await tx.query(
        `INSERT INTO bitrix24_assignment_remote (bitrix_object, bitrix_id, entity_type, erp_id)
         VALUES ($1, $2, $3, $4::bigint)
         ON CONFLICT (bitrix_object, bitrix_id) DO UPDATE
           SET entity_type=EXCLUDED.entity_type, erp_id=EXCLUDED.erp_id, retired_at=NULL, updated_at=now()`,
        [current.bitrixObject, current.bitrixId, entity.entityType, entity.erpId],
      );
      await tx.query(
        `UPDATE bitrix24_assignment_remote
            SET retired_at=now(), updated_at=now()
          WHERE entity_type=$1 AND erp_id=$2::bigint AND retired_at IS NULL
            AND NOT (bitrix_object=$3 AND bitrix_id=$4)`,
        [entity.entityType, entity.erpId, current.bitrixObject, current.bitrixId],
      );
      const row = await tx.query<RemoteRow>(`${REMOTE_SELECT} WHERE bitrix_object=$1 AND bitrix_id=$2`, [
        current.bitrixObject,
        current.bitrixId,
      ]);
      return toRemote(row.rows[0]);
    });
  }

  /**
   * ERP's choice: the Bitrix24 user mapped to the order's manager, else to its author. A client follows its latest
   * production order, else its author. Only active, non-service ERP users with an active mapping count.
   */
  async desired(entityType: AssignmentEntityType, erpId: string): Promise<DesiredAssignment | null> {
    const orderId = entityType === 'order' ? erpId : await this.latestOrderOfClient(erpId);
    if (orderId) {
      const result = await this.db.query<{
        manager_bitrix: string | null;
        manager_id: string | null;
        author_bitrix: string | null;
        created_by: string | null;
      }>(
        `SELECT manager.bitrix_user_id AS manager_bitrix, o.manager_id::text AS manager_id,
                author.bitrix_user_id AS author_bitrix, o.created_by::text AS created_by
           FROM orders o
           LEFT JOIN LATERAL (${MAPPED_USER('o.manager_id')}) manager ON true
           LEFT JOIN LATERAL (${MAPPED_USER('o.created_by')}) author ON true
          WHERE o.order_id=$1::bigint
            AND o.delete_flag=false
            AND o.order_kind='production_order'`,
        [orderId],
      );
      const row = result.rows[0];
      if (row?.manager_bitrix && row.manager_id) {
        return {
          bitrixUserId: row.manager_bitrix,
          erpUserId: row.manager_id,
          source: entityType === 'order' ? 'manager' : 'client_latest_order',
          orderId: entityType === 'client' ? orderId : null,
        };
      }
      if (row?.author_bitrix && row.created_by) {
        return {
          bitrixUserId: row.author_bitrix,
          erpUserId: row.created_by,
          source: entityType === 'order' ? 'created_by' : 'client_latest_order',
          orderId: entityType === 'client' ? orderId : null,
        };
      }
      return null;
    }
    if (entityType === 'order') return null;
    const result = await this.db.query<{ bitrix_user_id: string; created_by: string }>(
      `SELECT author.bitrix_user_id, c.created_by::text AS created_by
         FROM clients c
         JOIN LATERAL (${MAPPED_USER('c.created_by')}) author ON true
        WHERE c.client_id=$1::bigint`,
      [erpId],
    );
    const row = result.rows[0];
    return row
      ? { bitrixUserId: row.bitrix_user_id, erpUserId: row.created_by, source: 'client_creator', orderId: null }
      : null;
  }

  private async latestOrderOfClient(clientId: string): Promise<string | null> {
    const result = await this.db.query<{ order_id: string }>(
      `SELECT order_id::text AS order_id
         FROM orders
        WHERE client_id=$1::bigint AND delete_flag=false AND order_kind='production_order'
        ORDER BY order_date DESC NULLS LAST, order_id DESC
        LIMIT 1`,
      [clientId],
    );
    return result.rows[0]?.order_id ?? null;
  }

  /**
   * Commits the start of a write before the call; the first write also stores the object's baseline. The decision
   * (value before, covered causes, source, deciding order) is kept with the operation for a later recovery.
   */
  async beginOp(
    entity: ClaimedAssignmentEntity,
    remote: AssignmentRemote,
    input: {
      target: string;
      purpose: AssignmentPurpose;
      generation: number;
      current: string | null;
      desiredSource: string | null;
      desiredOrderId: string | null;
      /** Causes the operation reports (default: the claim's). */
      causeIds?: number[];
    },
  ): Promise<string> {
    const opId = randomUUID();
    await this.db.transaction(async (tx) => {
      await this.assertLease(tx, entity);
      const updated = await tx.query(
        `UPDATE bitrix24_assignment_remote
            SET op_id=$3, op_target=$4, op_entity_version=$5, op_generation=$6, op_purpose=$7, op_started_at=now(),
                op_before=$8, op_desired_source=$9, op_desired_order_id=$10::bigint, op_cause_ids=$11::bigint[],
                original_assigned_by_id=CASE WHEN original_captured THEN original_assigned_by_id ELSE $8 END,
                original_captured=true,
                observed_assigned_by_id=$8, observed_at=now(), updated_at=now()
          WHERE bitrix_object=$1 AND bitrix_id=$2 AND op_id IS NULL`,
        [
          remote.bitrixObject,
          remote.bitrixId,
          opId,
          input.target,
          entity.version,
          input.generation,
          input.purpose,
          input.current,
          input.desiredSource,
          input.desiredOrderId,
          input.causeIds ?? entity.causeIds,
        ],
      );
      if (updated.rowCount !== 1) throw new AssignmentLeaseLost();
    });
    return opId;
  }

  /** An in-flight write that did not take effect: forget it (the entity is processed again). */
  async clearOp(remote: AssignmentRemote, opId: string, observed: string | null, retire: boolean): Promise<void> {
    await this.db.query(
      `UPDATE bitrix24_assignment_remote
          SET op_id=NULL, op_target=NULL, op_entity_version=NULL, op_generation=NULL, op_purpose=NULL,
              op_started_at=NULL, op_before=NULL, op_desired_source=NULL, op_desired_order_id=NULL, op_cause_ids=NULL,
              observed_assigned_by_id=$4, observed_at=now(),
              retired_at=CASE WHEN $5::boolean THEN COALESCE(retired_at, now()) ELSE retired_at END,
              restore_outcome=CASE WHEN $5::boolean AND restore_outcome='pending' THEN 'missing' ELSE restore_outcome END,
              updated_at=now()
        WHERE bitrix_object=$1 AND bitrix_id=$2 AND op_id=$3`,
      [remote.bitrixObject, remote.bitrixId, opId, observed, retire],
    );
  }

  /**
   * Confirms a write that took effect (Bitrix24 shows `op_target`): remote state, journal, the causes it covered (with
   * the request id of the ERP command found through the transaction), audit and the domain event — one transaction,
   * only for the same op_id, from the decision stored with the operation. Newer causes stay open.
   */
  async finalize(input: FinalizeInput): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const locked = await tx.query<RemoteRow>(
        `${REMOTE_SELECT} WHERE bitrix_object=$1 AND bitrix_id=$2 AND op_id=$3 FOR UPDATE`,
        [input.remote.bitrixObject, input.remote.bitrixId, input.opId],
      );
      if (locked.rowCount !== 1) return null;
      const remote = toRemote(locked.rows[0]);
      const settings = await this.settings(tx);
      const covered = remote.opEntityVersion ?? 0;
      const coveredIds = remote.opCauseIds ?? [];
      const causes = await tx.query<{
        cause_id: string;
        actor_user_id: string | null;
        correlation_id: string | null;
        cause_type: string;
      }>(
        `SELECT cause.cause_id, cause.actor_user_id::text AS actor_user_id, cause.cause_type,
                COALESCE(cause.correlation_id, (
                  SELECT audit.request_id
                    FROM audit_log audit
                   WHERE audit.created_at = cause.xact_at
                     AND audit.request_id IS NOT NULL
                     AND (
                       (cause.cause_type='order_change' AND cause.ref_id ~ '^[0-9]+$' AND audit.related_order_id = cause.ref_id::bigint)
                       OR (cause.cause_type='client_change' AND cause.ref_id ~ '^[0-9]+$' AND audit.related_client_id = cause.ref_id::bigint)
                     )
                   ORDER BY audit.created_at
                   LIMIT 1
                )) AS correlation_id
           FROM bitrix24_assignment_cause cause
          WHERE cause.entity_type=$1 AND cause.erp_id=$2::bigint AND cause.cause_id = ANY($3::bigint[])
          ORDER BY cause.cause_id`,
        [remote.entityType, remote.erpId, coveredIds],
      );
      const purpose = remote.opPurpose ?? 'assign';
      // A write confirmed while a restore runs joins that restore (it must be undone too).
      const joinRestore = settings.mode === 'restore' && purpose !== 'restore'
        && remote.restoreGeneration !== settings.generation;
      await tx.query(
        `UPDATE bitrix24_assignment_remote remote
            SET sent_assigned_by_id=op_target, sent_at=now(),
                observed_assigned_by_id=op_target, observed_at=now(),
                managed=true,
                restore_outcome=CASE
                  -- Restored only when the write reached the current target (set-release may have moved it).
                  WHEN op_purpose='restore' AND restore_generation=op_generation
                       AND op_target IS NOT DISTINCT FROM restore_target THEN 'restored'
                  WHEN op_purpose='restore' AND restore_generation=op_generation THEN 'pending'
                  WHEN $4::boolean THEN 'pending'
                  ELSE restore_outcome END,
                restore_generation=CASE WHEN $4::boolean THEN $5 ELSE restore_generation END,
                restore_target=CASE WHEN $4::boolean THEN ${RESTORE_TARGET_SQL} ELSE restore_target END,
                op_id=NULL, op_target=NULL, op_entity_version=NULL, op_generation=NULL, op_purpose=NULL,
                op_started_at=NULL, op_before=NULL, op_desired_source=NULL, op_desired_order_id=NULL, op_cause_ids=NULL, updated_at=now()
          WHERE bitrix_object=$1 AND bitrix_id=$2 AND op_id=$3`,
        [remote.bitrixObject, remote.bitrixId, input.opId, joinRestore, settings.generation, settings.releaseAssignedById],
      );
      const changeId = randomUUID();
      const orderId = remote.entityType === 'order' ? Number(remote.erpId) : null;
      const clientId = remote.entityType === 'client' ? Number(remote.erpId) : null;
      const winningOrderId = remote.opDesiredOrderId === null ? null : Number(remote.opDesiredOrderId);
      const causeIds = causes.rows.map((row) => Number(row.cause_id));
      const initiators = [...new Set(causes.rows.map((row) => row.actor_user_id).filter((id): id is string => id !== null))];
      const correlations = [...new Set(causes.rows.map((row) => row.correlation_id).filter((id): id is string => id !== null))];
      const generation = remote.opGeneration ?? settings.generation;
      await tx.query(
        `INSERT INTO bitrix24_assignment_change (
           change_id, entity_type, erp_id, order_id, client_id, winning_order_id, bitrix_object, bitrix_id,
           before_assigned_by_id, after_assigned_by_id, desired_source, purpose, op_id, generation, covered_cause_id, cause_ids
         ) VALUES ($1,$2,$3::bigint,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::bigint[])`,
        [
          changeId,
          remote.entityType,
          remote.erpId,
          orderId,
          clientId,
          winningOrderId,
          remote.bitrixObject,
          remote.bitrixId,
          remote.opBefore,
          remote.opTarget,
          remote.opDesiredSource,
          purpose,
          input.opId,
          generation,
          covered,
          causeIds,
        ],
      );
      const facts = {
        changeId,
        entityType: remote.entityType,
        orderId,
        clientId,
        winningOrderId,
        bitrixObject: remote.bitrixObject,
        bitrixId: remote.bitrixId,
        before: remote.opBefore,
        after: remote.opTarget,
        purpose,
        desiredSource: remote.opDesiredSource,
        generation,
        coveredCauseId: covered,
        causeIds,
        causeTypes: [...new Set(causes.rows.map((row) => row.cause_type))],
        initiatorUserIds: initiators.map(Number),
        correlationIds: correlations,
      };
      // The actor of the write is the integration (null); the ERP users and requests that caused it are recorded apart.
      await this.audit.record(tx, {
        event: 'bitrix24.assignment.changed',
        entityType: remote.entityType,
        entityId: remote.erpId,
        actorUserId: null,
        requestId: correlations[0] ?? `bitrix24-assignment:${changeId}`,
        source: 'crm-sync-assignment',
        relatedOrderId: orderId ?? winningOrderId,
        relatedClientId: clientId,
        before: { assignedById: remote.opBefore },
        after: { assignedById: remote.opTarget },
        metadata: facts,
      });
      await tx.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
         VALUES ('bitrix24.assignment.changed', 'crm_sync', $1, $2::jsonb, $3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [`${remote.entityType}:${remote.erpId}`, JSON.stringify(facts), `bitrix24.assignment:${changeId}`],
      );
      await closeCauses(tx, remote.entityType, remote.erpId, coveredIds);
      await tx.query(
        `UPDATE bitrix24_assignment_entity
            SET attempts=0, last_error_code=NULL, last_error=NULL, updated_at=now()
          WHERE entity_type=$1 AND erp_id=$2::bigint`,
        [remote.entityType, remote.erpId],
      );
      return changeId;
    });
  }

  /** The object already shows ERP's choice: ERP takes it over without writing (no change event). */
  async enroll(entity: ClaimedAssignmentEntity, remote: AssignmentRemote, current: string, causeIds?: number[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.assertLease(tx, entity);
      const settings = await this.settings(tx);
      const joinRestore = settings.mode === 'restore' && remote.restoreGeneration !== settings.generation;
      const updated = await tx.query(
        `UPDATE bitrix24_assignment_remote remote
            SET managed=true, enrolled_at=COALESCE(enrolled_at, now()),
                original_assigned_by_id=CASE WHEN original_captured THEN original_assigned_by_id ELSE $3 END,
                original_captured=true,
                sent_assigned_by_id=$3, sent_at=now(), observed_assigned_by_id=$3, observed_at=now(),
                restore_generation=CASE WHEN $4::boolean THEN $5 ELSE restore_generation END,
                restore_outcome=CASE WHEN $4::boolean THEN 'pending' ELSE restore_outcome END,
                restore_target=CASE WHEN $4::boolean THEN ${RESTORE_TARGET_SQL} ELSE restore_target END,
                updated_at=now()
          WHERE bitrix_object=$1 AND bitrix_id=$2 AND op_id IS NULL AND NOT managed`,
        [remote.bitrixObject, remote.bitrixId, current, joinRestore, settings.generation, settings.releaseAssignedById],
      );
      if (updated.rowCount !== 1) return;
      await this.audit.record(tx, {
        event: 'bitrix24.assignment.enrolled',
        entityType: entity.entityType,
        entityId: entity.erpId,
        actorUserId: null,
        requestId: `bitrix24-assignment:${entity.entityType}:${entity.erpId}:${entity.version}`,
        source: 'crm-sync-assignment',
        relatedOrderId: entity.entityType === 'order' ? Number(entity.erpId) : null,
        relatedClientId: entity.entityType === 'client' ? Number(entity.erpId) : null,
        after: { assignedById: current },
        metadata: { bitrixObject: remote.bitrixObject, bitrixId: remote.bitrixId, entityVersion: entity.version, causeIds: causeIds ?? [] },
      });
    });
  }

  async setRestoreOutcome(remote: AssignmentRemote, generation: number, outcome: RestoreOutcome, observed?: string | null): Promise<void> {
    await this.db.query(
      `UPDATE bitrix24_assignment_remote
          SET restore_outcome=$4,
              observed_assigned_by_id=CASE WHEN $5::boolean THEN $6 ELSE observed_assigned_by_id END,
              observed_at=CASE WHEN $5::boolean THEN now() ELSE observed_at END,
              retired_at=CASE WHEN $4='missing' THEN COALESCE(retired_at, now()) ELSE retired_at END,
              updated_at=now()
        WHERE bitrix_object=$1 AND bitrix_id=$2 AND restore_generation=$3 AND op_id IS NULL`,
      [remote.bitrixObject, remote.bitrixId, generation, outcome, observed !== undefined, observed ?? null],
    );
  }

  /** Closes the causes the claim saw (a no-op or a finished pass) and gives the claim back; newer causes stay open. */
  async markProcessed(
    entity: ClaimedAssignmentEntity,
    desired: { assignedById: string | null; source: string | null; erpUserId: string | null; orderId: string | null },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE bitrix24_assignment_entity
            SET desired_assigned_by_id=$4, desired_source=$5, desired_erp_user_id=$6::bigint, desired_order_id=$7::bigint,
                attempts=0, last_error_code=NULL, last_error=NULL, lease_token=NULL, lease_until=NULL,
                next_attempt_at=now(), updated_at=now()
          WHERE entity_type=$1 AND erp_id=$2::bigint AND lease_token=$3`,
        [entity.entityType, entity.erpId, entity.leaseToken, desired.assignedById, desired.source, desired.erpUserId, desired.orderId],
      );
      if (updated.rowCount !== 1) throw new AssignmentLeaseLost();
      await closeCauses(tx, entity.entityType, entity.erpId, entity.causeIds);
    });
  }

  async rememberDesired(
    entity: ClaimedAssignmentEntity,
    desired: { assignedById: string | null; source: string | null; erpUserId: string | null; orderId: string | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE bitrix24_assignment_entity
          SET desired_assigned_by_id=$4, desired_source=$5, desired_erp_user_id=$6::bigint, desired_order_id=$7::bigint,
              updated_at=now()
        WHERE entity_type=$1 AND erp_id=$2::bigint AND lease_token=$3`,
      [entity.entityType, entity.erpId, entity.leaseToken, desired.assignedById, desired.source, desired.erpUserId, desired.orderId],
    );
  }

  /** Gives the claim back: the entity is tried again at `nextAt`, or at once when a newer cause arrives. */
  async defer(
    entity: ClaimedAssignmentEntity,
    nextAt: Date,
    error: { code: string; message?: string | null; countAttempt: boolean },
  ): Promise<void> {
    await this.db.query(
      `UPDATE bitrix24_assignment_entity
          SET next_attempt_at=$4,
              attempts=attempts + CASE WHEN $7::boolean THEN 1 ELSE 0 END,
              last_error_code=$5, last_error=$6, lease_token=NULL, lease_until=NULL, updated_at=now()
        WHERE entity_type=$1 AND erp_id=$2::bigint AND lease_token=$3`,
      [entity.entityType, entity.erpId, entity.leaseToken, nextAt, error.code, error.message ?? null, error.countAttempt],
    );
  }

  /** Releases the claim without recording anything (ownership lost, unexpected error). */
  async release(entity: ClaimedAssignmentEntity, nextAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE bitrix24_assignment_entity
          SET lease_token=NULL, lease_until=NULL, next_attempt_at=$4, updated_at=now()
        WHERE entity_type=$1 AND erp_id=$2::bigint AND lease_token=$3`,
      [entity.entityType, entity.erpId, entity.leaseToken, nextAt],
    );
  }

  /**
   * One batch of an open fan-out (a changed user mapping): orders the users manage or wrote, with their clients, then
   * clients the users wrote. Each batch is its own transaction with one sorted invalidation.
   */
  async advanceFanout(batchSize: number): Promise<number> {
    return this.db.transaction(async (tx) => {
      const open = await tx.query<{
        fanout_id: string;
        erp_user_ids: string[];
        actor_user_id: string | null;
        correlation_id: string | null;
        mapping_id: string;
        phase: 'orders' | 'clients';
        cursor_id: string;
      }>(
        `SELECT fanout_id, erp_user_ids, actor_user_id, correlation_id, mapping_id, phase, cursor_id
           FROM bitrix24_assignment_fanout
          WHERE phase <> 'done'
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
      );
      const fanout = open.rows[0];
      if (!fanout) return 0;
      const users = fanout.erp_user_ids.map(Number);
      const types: string[] = [];
      const ids: number[] = [];
      let last: number | null = null;
      if (fanout.phase === 'orders') {
        const rows = await tx.query<{ order_id: string; client_id: string | null }>(
          `SELECT order_id, client_id
             FROM orders
            WHERE order_id > $2::bigint AND (manager_id = ANY($1::bigint[]) OR created_by = ANY($1::bigint[]))
            ORDER BY order_id
            LIMIT $3`,
          [users, fanout.cursor_id, batchSize],
        );
        for (const row of rows.rows) {
          types.push('order');
          ids.push(Number(row.order_id));
          if (row.client_id !== null) {
            types.push('client');
            ids.push(Number(row.client_id));
          }
          last = Number(row.order_id);
        }
      } else {
        const rows = await tx.query<{ client_id: string }>(
          `SELECT client_id FROM clients
            WHERE client_id > $2::bigint AND created_by = ANY($1::bigint[])
            ORDER BY client_id
            LIMIT $3`,
          [users, fanout.cursor_id, batchSize],
        );
        for (const row of rows.rows) {
          types.push('client');
          ids.push(Number(row.client_id));
          last = Number(row.client_id);
        }
      }
      const touched = ids.length === 0
        ? 0
        : Number((await tx.query<{ touched: number }>(
            `SELECT bitrix24_assignment_touch($1::text[], $2::bigint[], 'user_mapping', $3, $4::bigint, $5) AS touched`,
            [types, ids, `mapping:${fanout.mapping_id}:fanout:${fanout.fanout_id}`, fanout.actor_user_id, fanout.correlation_id],
          )).rows[0]?.touched ?? 0);
      if (last === null) {
        const next = fanout.phase === 'orders' ? 'clients' : 'done';
        await tx.query(
          `UPDATE bitrix24_assignment_fanout
              SET phase=$2, cursor_id=0, finished_at=CASE WHEN $2='done' THEN now() ELSE NULL END
            WHERE fanout_id=$1`,
          [fanout.fanout_id, next],
        );
      } else {
        await tx.query(
          `UPDATE bitrix24_assignment_fanout SET cursor_id=$2, touched=touched + $3 WHERE fanout_id=$1`,
          [fanout.fanout_id, last, touched],
        );
      }
      return ids.length;
    });
  }

  /** Closed causes are kept 90 days. */
  async purgeOldCauses(): Promise<void> {
    await this.db.query(
      `DELETE FROM bitrix24_assignment_cause WHERE processed AND created_at < now() - interval '90 days'`,
    );
  }

  async causeIdsFor(entity: ClaimedAssignmentEntity): Promise<number[]> {
    return entity.causeIds;
  }

  private async assertLease(tx: TransactionClient, entity: ClaimedAssignmentEntity): Promise<void> {
    const lease = await tx.query(
      `SELECT 1 FROM bitrix24_assignment_entity
        WHERE entity_type=$1 AND erp_id=$2::bigint AND lease_token=$3 AND lease_until > now()
        FOR UPDATE`,
      [entity.entityType, entity.erpId, entity.leaseToken],
    );
    if (lease.rowCount !== 1) throw new AssignmentLeaseLost();
  }
}

/**
 * Ordinary sync (relay and backfill CLI alike) must not send `assignedById` of an object the channel owns while the
 * channel is not off.
 */
export function assignmentOwnership(db: Pick<DatabaseClient, 'query'>): {
  ownsAssignment(entityType: AssignmentEntityType, erpId: string): Promise<boolean>;
} {
  return {
    async ownsAssignment(entityType, erpId) {
      const result = await db.query<{ owned: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM bitrix24_assignment_remote remote
             JOIN bitrix24_assignment_settings settings ON settings.singleton AND settings.mode <> 'off'
            WHERE remote.entity_type=$1 AND remote.erp_id=$2::bigint
              AND remote.retired_at IS NULL
              AND (remote.managed OR remote.op_id IS NOT NULL)
         ) AS owned`,
        [entityType, erpId],
      );
      return result.rows[0]?.owned === true;
    },
  };
}

/** Closes exactly the given causes (a cause that committed later, even with a lower id, stays open). */
async function closeCauses(tx: TransactionClient, entityType: string, erpId: string, causeIds: readonly number[]): Promise<void> {
  if (causeIds.length === 0) return;
  await tx.query(
    `UPDATE bitrix24_assignment_cause SET processed=true
      WHERE entity_type=$1 AND erp_id=$2::bigint AND NOT processed AND cause_id = ANY($3::bigint[])`,
    [entityType, erpId, [...causeIds]],
  );
  await tx.query(
    `UPDATE bitrix24_assignment_entity SET processed_cause_id=GREATEST(processed_cause_id, $3), updated_at=now()
      WHERE entity_type=$1 AND erp_id=$2::bigint`,
    [entityType, erpId, Math.max(...causeIds)],
  );
}

export class AssignmentLeaseLost extends Error {
  constructor() {
    super('crm-sync: assignment lease lost');
    this.name = 'AssignmentLeaseLost';
  }
}

/** Active, non-service ERP user `column` with an active Bitrix24 user mapping (one row at most: unique index). */
function MAPPED_USER(column: string): string {
  return `SELECT mapping.bitrix_user_id
            FROM bitrix24_user_mapping mapping
            JOIN users target ON target.user_id=mapping.erp_user_id
           WHERE mapping.erp_user_id=${column}
             AND mapping.is_active=true
             AND target.is_active=true
             AND target.is_service_account=false
           LIMIT 1`;
}

/**
 * Restore target of a remote row (inside UPDATE … remote): before the feature ERP-owned objects were reassigned to the
 * fallback user on every sync, so they return to it ($6); Bitrix-owned objects return to their own baseline.
 */
const RESTORE_TARGET_SQL = `(
  SELECT CASE WHEN mapping.source_system='bitrix24' THEN remote.original_assigned_by_id ELSE $6 END
    FROM (SELECT 1) one
    LEFT JOIN crm_sync_mapping mapping
      ON mapping.entity_type=remote.entity_type AND mapping.erp_id=remote.erp_id::text
)`;

const REMOTE_SELECT = `SELECT bitrix_object, bitrix_id, entity_type, erp_id::text AS erp_id, managed, original_captured,
         original_assigned_by_id, sent_assigned_by_id, op_id, op_target, op_before, op_entity_version,
         op_desired_source, op_desired_order_id::text AS op_desired_order_id, op_cause_ids::text[] AS op_cause_ids,
         op_generation, op_purpose,
         restore_generation, restore_target, restore_cause_ids::text[] AS restore_cause_ids, restore_outcome, retired_at
    FROM bitrix24_assignment_remote`;

interface RemoteRow {
  bitrix_object: AssignmentObject;
  bitrix_id: string;
  entity_type: AssignmentEntityType;
  erp_id: string;
  managed: boolean;
  original_captured: boolean;
  original_assigned_by_id: string | null;
  sent_assigned_by_id: string | null;
  op_id: string | null;
  op_target: string | null;
  op_before: string | null;
  op_entity_version: string | null;
  op_cause_ids: string[] | null;
  op_desired_source: string | null;
  op_desired_order_id: string | null;
  op_generation: number | null;
  op_purpose: AssignmentPurpose | null;
  restore_generation: number | null;
  restore_target: string | null;
  restore_cause_ids: string[] | null;
  restore_outcome: RestoreOutcome | null;
  retired_at: Date | null;
}

function toRemote(row: RemoteRow): AssignmentRemote {
  if (!ENTITY_TYPES.has(row.entity_type)) throw new Error(`crm-sync: bad assignment entity type ${String(row.entity_type)}`);
  return {
    bitrixObject: row.bitrix_object,
    bitrixId: row.bitrix_id,
    entityType: row.entity_type,
    erpId: String(row.erp_id),
    managed: row.managed,
    originalCaptured: row.original_captured,
    originalAssignedById: row.original_assigned_by_id,
    sentAssignedById: row.sent_assigned_by_id,
    opId: row.op_id,
    opTarget: row.op_target,
    opBefore: row.op_before,
    opEntityVersion: row.op_entity_version === null ? null : Number(row.op_entity_version),
    opCauseIds: row.op_cause_ids === null ? null : row.op_cause_ids.map(Number),
    opDesiredSource: row.op_desired_source,
    opDesiredOrderId: row.op_desired_order_id,
    opGeneration: row.op_generation === null ? null : Number(row.op_generation),
    opPurpose: row.op_purpose,
    restoreGeneration: row.restore_generation === null ? null : Number(row.restore_generation),
    restoreTarget: row.restore_target,
    restoreCauseIds: row.restore_cause_ids === null ? null : row.restore_cause_ids.map(Number),
    restoreOutcome: row.restore_outcome,
    retiredAt: row.retired_at,
  };
}
