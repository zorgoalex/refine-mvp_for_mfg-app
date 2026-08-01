import { createHash, randomUUID } from 'node:crypto';
import type { AuditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import {
  calculateDetailArea,
  calculateDetailCost,
  calculatePaymentStatusId,
  roundMoney,
} from '../../orders/domain/order-calculations';
import { DatabaseService } from '../../../database/database.service';
import type {
  Bitrix24InboundEventPayload,
  Bitrix24InboundEventRow,
  Bitrix24InstallationPayload,
  Bitrix24InstallationRow,
  Bitrix24RefreshLease,
  Bitrix24ReverseObjectType,
} from './bitrix24-reverse.types';

export interface ReverseMappingRow {
  entityType: 'client' | 'order' | 'payment';
  erpId: string;
  bitrixObject: string;
  bitrixId: string | null;
  parentErpId: string | null;
  status: string;
  sourceSystem: 'erp' | 'bitrix24';
  lastBitrixHash: string | null;
  lastBitrixUpdatedAt: Date | null;
}

export interface ReverseClientSnapshot {
  objectType: 'contact' | 'company';
  bitrixId: string;
  name: string;
  notes: string | null;
  phones: Array<{
    phoneNumber: string;
    phoneType: 'mobile' | 'work' | 'home' | 'fax';
    isPrimary: boolean;
  }>;
  originErpId: string | null;
  normalizedHash: string;
  bitrixCreatedAt: Date | null;
  bitrixUpdatedAt: Date | null;
  rawSnapshot: Record<string, unknown>;
}

export interface ReverseDealSnapshot {
  bitrixId: string;
  title: string;
  fullTitle: string;
  clientId: number | null;
  counterpartyObjectType: 'contact' | 'company' | null;
  counterpartyBitrixId: string | null;
  originErpOrderId: string | null;
  crmAmount: number | null;
  currencyId: string | null;
  stageId: string | null;
  assignedById: string | null;
  beginDate: string | null;
  closeDate: string | null;
  comments: string | null;
  bitrixUrl: string;
  normalizedHash: string;
  remoteRevision: string;
  bitrixCreatedAt: Date | null;
  bitrixUpdatedAt: Date | null;
  rawSnapshot: Record<string, unknown>;
}

export interface ReversePaymentSnapshot {
  bitrixPaymentId: string;
  paySystemId: number | null;
  paySystemName: string | null;
  amount: number;
  currencyId: string | null;
  paid: boolean;
  paymentDate: Date | null;
  normalizedHash: string;
  bitrixCreatedAt: Date | null;
  bitrixUpdatedAt: Date | null;
}

export interface ReverseDealMaterializationOptions {
  actorUserId: number;
}

export interface IncomingRequestDetailInput {
  id?: number;
  detailName?: string | null;
  height: number;
  width: number;
  quantity: number;
  sheetMaterialTypeId: number;
  millingTypeId: number;
  edgeTypeId: number;
  filmId?: number | null;
  millingCostPerSqm?: number | null;
  detailCost?: number | null;
  priority: number;
  note?: string | null;
}

export class PgBitrix24ReverseRepository {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async assertReverseSyncReady(actorUserId: number): Promise<void> {
    const result = await this.db.query(
      `SELECT 1
         FROM users actor
         JOIN roles actor_role ON actor_role.role_id=actor.role_id
        WHERE actor.user_id=$1
          AND actor.is_active=true
          AND actor.is_service_account=true
          AND actor_role.role_code='integration_service'
          AND actor_role.is_active=true
          AND EXISTS (
            SELECT 1 FROM order_statuses
             WHERE order_status_code='crm_request' AND is_active=true
          )
          AND EXISTS (
            SELECT 1 FROM payment_statuses
             WHERE upper(payment_status_code) IN ('NOT_PAID','UNPAID')
               AND is_active=true
          )`,
      [actorUserId],
    );
    if (result.rowCount !== 1) {
      throw new ApiError(
        503,
        'BITRIX24_REVERSE_PREREQUISITE_INVALID',
        'Bitrix24 reverse synchronization service actor or status catalog is invalid',
      );
    }
  }

  async saveInstallation(input: {
    payload: Bitrix24InstallationPayload;
    accessTokenCiphertext: string;
    refreshTokenCiphertext: string;
    applicationTokenHash: string;
    requestId: string;
  }): Promise<void> {
    const expiresAt = new Date(Date.now() + input.payload.expiresIn * 1000);
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO bitrix24_app_installation (
           member_id, domain, access_token_ciphertext, refresh_token_ciphertext,
           access_token_expires_at, application_token_hash, status,
           installed_at, refreshed_at, last_error, updated_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,'active',now(),NULL,NULL,now())
         ON CONFLICT (member_id) DO UPDATE SET
           domain=EXCLUDED.domain,
           access_token_ciphertext=EXCLUDED.access_token_ciphertext,
           refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,
           access_token_expires_at=EXCLUDED.access_token_expires_at,
           application_token_hash=EXCLUDED.application_token_hash,
           status='active', last_error=NULL, updated_at=now()`,
        [
          input.payload.memberId,
          input.payload.domain,
          input.accessTokenCiphertext,
          input.refreshTokenCiphertext,
          expiresAt,
          input.applicationTokenHash,
        ],
      );
      await this.audit.record(tx, {
        event: 'bitrix24_reverse.installation_saved',
        entityType: 'bitrix24_app_installation',
        entityId: input.payload.memberId,
        actorUserId: null,
        requestId: input.requestId,
        source: 'bitrix24',
        after: {
          domain: input.payload.domain,
          status: 'active',
          expiresAt: expiresAt.toISOString(),
        },
      });
    });
  }

  async getInstallation(memberId: string): Promise<Bitrix24InstallationRow | null> {
    const result = await this.db.query<{
      member_id: string;
      domain: string;
      access_token_ciphertext: string;
      refresh_token_ciphertext: string;
      access_token_expires_at: Date | string;
      application_token_hash: string;
      status: Bitrix24InstallationRow['status'];
    }>(
      `SELECT member_id, domain, access_token_ciphertext, refresh_token_ciphertext,
              access_token_expires_at, application_token_hash, status
         FROM bitrix24_app_installation
        WHERE member_id=$1`,
      [memberId],
    );
    const row = result.rows[0];
    return row
      ? {
          memberId: row.member_id,
          domain: row.domain,
          accessTokenCiphertext: row.access_token_ciphertext,
          refreshTokenCiphertext: row.refresh_token_ciphertext,
          accessTokenExpiresAt: new Date(row.access_token_expires_at),
          applicationTokenHash: row.application_token_hash,
          status: row.status,
        }
      : null;
  }

  async getInstallationByDomain(
    domain: string,
  ): Promise<Bitrix24InstallationRow | null> {
    const result = await this.db.query<{ member_id: string }>(
      `SELECT member_id
         FROM bitrix24_app_installation
        WHERE domain=$1 AND status <> 'revoked'
        ORDER BY updated_at DESC
        LIMIT 1`,
      [domain],
    );
    const memberId = result.rows[0]?.member_id;
    return memberId ? this.getInstallation(memberId) : null;
  }

  async markInstallationError(memberId: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE bitrix24_app_installation
          SET status='refresh_failed', last_error=$2, updated_at=now()
        WHERE member_id=$1`,
      [memberId, error.slice(0, 1000)],
    );
  }

  async claimInstallationRefresh(input: {
    refreshLeadMs: number;
    leaseMs: number;
    domain?: string;
    force?: boolean;
  }): Promise<Bitrix24RefreshLease | null> {
    const lockToken = randomUUID();
    return this.db.transaction(async (tx) => {
      const result = await tx.query<{
        member_id: string;
        domain: string;
        access_token_ciphertext: string;
        refresh_token_ciphertext: string;
      }>(
        `WITH candidate AS (
           SELECT member_id
             FROM bitrix24_app_installation
            WHERE status <> 'revoked'
              AND ($1::text IS NULL OR domain=$1)
              AND access_token_expires_at
                    <= CASE WHEN $2::boolean
                         THEN 'infinity'::timestamptz
                         ELSE now() + ($3::int * interval '1 millisecond')
                       END
              AND refresh_next_attempt_at <= now()
              AND (
                refresh_locked_at IS NULL
                OR refresh_locked_at
                     < now() - ($4::int * interval '1 millisecond')
              )
            ORDER BY access_token_expires_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
         UPDATE bitrix24_app_installation installation
            SET refresh_locked_at=now(), refresh_lock_token=$5,
                updated_at=now()
           FROM candidate
          WHERE installation.member_id=candidate.member_id
         RETURNING installation.member_id, installation.domain,
                   installation.access_token_ciphertext,
                   installation.refresh_token_ciphertext`,
        [
          input.domain ?? null,
          input.force ?? false,
          input.refreshLeadMs,
          input.leaseMs,
          lockToken,
        ],
      );
      const row = result.rows[0];
      return row
        ? {
            memberId: row.member_id,
            domain: row.domain,
            accessTokenCiphertext: row.access_token_ciphertext,
            refreshTokenCiphertext: row.refresh_token_ciphertext,
            lockToken,
          }
        : null;
    });
  }

  async completeInstallationRefresh(input: {
    memberId: string;
    lockToken: string;
    accessTokenCiphertext: string;
    refreshTokenCiphertext: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE bitrix24_app_installation
          SET access_token_ciphertext=$3, refresh_token_ciphertext=$4,
              access_token_expires_at=$5, status='active',
              refreshed_at=now(), refresh_next_attempt_at=now(),
              refresh_locked_at=NULL, refresh_lock_token=NULL,
              last_error=NULL, updated_at=now()
        WHERE member_id=$1 AND refresh_lock_token=$2::uuid`,
      [
        input.memberId,
        input.lockToken,
        input.accessTokenCiphertext,
        input.refreshTokenCiphertext,
        input.expiresAt,
      ],
    );
    return result.rowCount === 1;
  }

  async failInstallationRefresh(input: {
    memberId: string;
    lockToken: string;
    error: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE bitrix24_app_installation
          SET status='refresh_failed', last_error=$3,
              refresh_next_attempt_at=now() + interval '1 minute',
              refresh_locked_at=NULL, refresh_lock_token=NULL, updated_at=now()
        WHERE member_id=$1 AND refresh_lock_token=$2::uuid`,
      [input.memberId, input.lockToken, input.error.slice(0, 1000)],
    );
  }

  async enqueueEvent(event: Bitrix24InboundEventPayload): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO bitrix24_inbound_event (
         member_id, event_name, object_type, bitrix_id, event_ts,
         payload_json, fingerprint
       )
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT DO NOTHING
       RETURNING inbound_event_id`,
      [
        event.memberId,
        event.eventName,
        event.objectType,
        event.bitrixId,
        event.eventTimestamp,
        JSON.stringify(event.storedPayload),
        event.fingerprint,
      ],
    );
    return result.rowCount === 1;
  }

  async claimEvents(input: {
    workerId: string;
    batchSize: number;
    leaseMs: number;
  }): Promise<Bitrix24InboundEventRow[]> {
    const lockToken = randomUUID();
    return this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE bitrix24_inbound_event
            SET status='failed', locked_at=NULL, locked_by=NULL, lock_token=NULL,
                next_attempt_at=now()
          WHERE status='processing'
            AND locked_at < now() - ($1::int * interval '1 millisecond')`,
        [input.leaseMs],
      );
      const result = await tx.query<{
        inbound_event_id: string;
        member_id: string;
        event_name: string;
        object_type: Bitrix24ReverseObjectType;
        bitrix_id: string;
        attempts: number;
      }>(
        `WITH claimed AS (
           SELECT inbound_event_id
             FROM bitrix24_inbound_event
            WHERE status IN ('pending','failed')
              AND next_attempt_at <= now()
            ORDER BY next_attempt_at, created_at
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE bitrix24_inbound_event event
            SET status='processing', attempts=event.attempts+1,
                locked_at=now(), locked_by=$2, lock_token=$3
           FROM claimed
          WHERE event.inbound_event_id=claimed.inbound_event_id
         RETURNING event.inbound_event_id, event.member_id, event.event_name,
                   event.object_type, event.bitrix_id, event.attempts`,
        [input.batchSize, input.workerId, lockToken],
      );
      return result.rows.map((row) => ({
        inboundEventId: row.inbound_event_id,
        memberId: row.member_id,
        eventName: row.event_name,
        objectType: row.object_type,
        operation: row.event_name.endsWith('DELETE') ? 'delete' : 'upsert',
        bitrixId: row.bitrix_id,
        attempts: row.attempts,
        lockToken,
      }));
    });
  }

  async markEventProcessed(event: Bitrix24InboundEventRow): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE bitrix24_inbound_event
          SET status='processed', processed_at=now(), last_error=NULL,
              locked_at=NULL, locked_by=NULL, lock_token=NULL
        WHERE inbound_event_id=$1 AND status='processing' AND lock_token=$2`,
      [event.inboundEventId, event.lockToken],
    );
    return result.rowCount === 1;
  }

  async heartbeatEvent(event: Bitrix24InboundEventRow): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE bitrix24_inbound_event
          SET locked_at=now()
        WHERE inbound_event_id=$1 AND status='processing' AND lock_token=$2`,
      [event.inboundEventId, event.lockToken],
    );
    return result.rowCount === 1;
  }

  async markEventFailed(
    event: Bitrix24InboundEventRow,
    error: string,
    maxAttempts: number,
  ): Promise<void> {
    const dead = event.attempts >= maxAttempts;
    const delaySeconds = Math.min(3600, 2 ** Math.min(event.attempts, 10));
    await this.db.query(
      `UPDATE bitrix24_inbound_event
          SET status=$3, last_error=$4,
              next_attempt_at=CASE WHEN $3='dead' THEN next_attempt_at
                                   ELSE now() + ($5::int * interval '1 second') END,
              locked_at=NULL, locked_by=NULL, lock_token=NULL
        WHERE inbound_event_id=$1 AND status='processing' AND lock_token=$2`,
      [
        event.inboundEventId,
        event.lockToken,
        dead ? 'dead' : 'failed',
        error.slice(0, 1000),
        delaySeconds,
      ],
    );
  }

  async findMappingByBitrix(
    objectType: string,
    bitrixId: string,
  ): Promise<ReverseMappingRow | null> {
    return this.readMapping(
      this.db,
      `bitrix_object=$1 AND bitrix_id=$2`,
      [objectType, bitrixId],
    );
  }

  async findMappingByErp(
    entityType: 'client' | 'order' | 'payment',
    erpId: string,
  ): Promise<ReverseMappingRow | null> {
    return this.readMapping(
      this.db,
      `entity_type=$1 AND erp_id=$2`,
      [entityType, erpId],
    );
  }

  async upsertClient(
    snapshot: ReverseClientSnapshot,
    requestId: string,
    lockToken?: string,
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      await assertInboundOwnership(tx, requestId, lockToken);
      await lockAggregate(tx, `client:${snapshot.objectType}:${snapshot.bitrixId}`);
      if (snapshot.originErpId) {
        await lockAggregate(tx, `client:erp:${snapshot.originErpId}`);
      }
      await setReverseOrigin(tx);
      const exact = await this.readMapping(
        tx,
        `entity_type='client' AND bitrix_object=$1 AND bitrix_id=$2`,
        [snapshot.objectType, snapshot.bitrixId],
      );
      const recovered = !exact && snapshot.originErpId
        ? await this.readMapping(
            tx,
            `entity_type='client' AND erp_id=$1`,
            [snapshot.originErpId],
          )
        : null;
      const mapping = exact ?? recovered;
      const clientId = mapping
        ? Number(mapping.erpId)
        : await insertClient(tx, snapshot);

      if (
        mapping?.status === 'active' &&
        mapping.lastBitrixHash === snapshot.normalizedHash
      ) {
        await enqueueUnresolvedDealsForCounterparty(
          tx,
          snapshot.objectType,
          snapshot.bitrixId,
        );
        return clientId;
      }
      if (
        mapping?.lastBitrixUpdatedAt &&
        snapshot.bitrixUpdatedAt &&
        snapshot.bitrixUpdatedAt < mapping.lastBitrixUpdatedAt
      ) {
        await enqueueUnresolvedDealsForCounterparty(
          tx,
          snapshot.objectType,
          snapshot.bitrixId,
        );
        return clientId;
      }

      if (mapping) {
        const result = await tx.query(
          `UPDATE clients
              SET client_name=$2, person_type=$3, notes=$4, is_active=true
            WHERE client_id=$1`,
          [
            clientId,
            snapshot.name,
            snapshot.objectType === 'company' ? 'legal' : 'individual',
            snapshot.notes,
          ],
        );
        if (result.rowCount !== 1) {
          throw new Error(`Bitrix24 mapped ERP client ${clientId} not found`);
        }
      }

      await tx.query('DELETE FROM client_phones WHERE client_id=$1', [clientId]);
      for (const phone of snapshot.phones) {
        await tx.query(
          `INSERT INTO client_phones (
             client_id, phone_number, phone_type, is_primary, ref_key_1c
           ) VALUES ($1,$2,$3,$4,NULL)`,
          [clientId, phone.phoneNumber, phone.phoneType, phone.isPrimary],
        );
      }

      await upsertMapping(tx, {
        entityType: 'client',
        erpId: String(clientId),
        bitrixObject: snapshot.objectType,
        bitrixId: snapshot.bitrixId,
        parentErpId: null,
        sourceSystem: mapping?.sourceSystem ?? 'bitrix24',
        normalizedHash: snapshot.normalizedHash,
        bitrixUpdatedAt: snapshot.bitrixUpdatedAt,
      });
      await upsertRemoteState(tx, {
        objectType: snapshot.objectType,
        bitrixId: snapshot.bitrixId,
        erpEntityType: 'client',
        erpId: String(clientId),
        normalizedHash: snapshot.normalizedHash,
        title: snapshot.name,
        bitrixCreatedAt: snapshot.bitrixCreatedAt,
        bitrixUpdatedAt: snapshot.bitrixUpdatedAt,
        rawSnapshot: snapshot.rawSnapshot,
      });
      await this.audit.record(tx, {
        event: 'bitrix24_reverse.client_upsert',
        entityType: 'client',
        entityId: clientId,
        actorUserId: null,
        requestId,
        source: 'bitrix24',
        relatedClientId: clientId,
        after: {
          name: snapshot.name,
          personType: snapshot.objectType === 'company' ? 'legal' : 'individual',
          phoneCount: snapshot.phones.length,
        },
        metadata: {
          bitrixObject: snapshot.objectType,
          bitrixId: snapshot.bitrixId,
          sourceSystem: mapping?.sourceSystem ?? 'bitrix24',
        },
      });
      await enqueueUnresolvedDealsForCounterparty(
        tx,
        snapshot.objectType,
        snapshot.bitrixId,
      );
      return clientId;
    });
  }

  async archiveClient(
    objectType: 'contact' | 'company',
    bitrixId: string,
    requestId: string,
    lockToken?: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await assertInboundOwnership(tx, requestId, lockToken);
      await lockAggregate(tx, `client:${objectType}:${bitrixId}`);
      await setReverseOrigin(tx);
      const suppressed = await consumeSuppression(tx, objectType, bitrixId, 'delete');
      if (suppressed) return false;
      const mapping = await this.readMapping(
        tx,
        `entity_type='client' AND bitrix_object=$1 AND bitrix_id=$2 AND status='active'`,
        [objectType, bitrixId],
      );
      if (!mapping) return false;
      await tx.query('UPDATE clients SET is_active=false WHERE client_id=$1', [mapping.erpId]);
      await tx.query(
        `UPDATE crm_sync_mapping
            SET status='deleted', updated_at=now(), last_synced_at=now()
          WHERE entity_type='client' AND erp_id=$1`,
        [mapping.erpId],
      );
      await this.audit.record(tx, {
        event: 'bitrix24_reverse.client_archive',
        entityType: 'client',
        entityId: mapping.erpId,
        actorUserId: null,
        requestId,
        source: 'bitrix24',
        relatedClientId: Number(mapping.erpId),
        after: { isActive: false },
        metadata: { bitrixObject: objectType, bitrixId },
      });
      return true;
    });
  }

  async upsertDeal(
    snapshot: ReverseDealSnapshot,
    requestId: string,
    lockToken?: string,
    materialization?: ReverseDealMaterializationOptions,
  ): Promise<{
    requestId: number | null;
    erpOrderId: string | null;
  }> {
    return this.db.transaction(async (tx) => {
      await assertInboundOwnership(tx, requestId, lockToken);
      await lockAggregate(tx, `deal:${snapshot.bitrixId}`);
      await setReverseOrigin(tx);
      const exact = await this.readMapping(
        tx,
        `entity_type='order' AND bitrix_object='deal' AND bitrix_id=$1`,
        [snapshot.bitrixId],
      );
      const recovered = !exact && snapshot.originErpOrderId
        ? await this.readMapping(
            tx,
            `entity_type='order' AND erp_id=$1`,
            [snapshot.originErpOrderId],
          )
        : null;
      const mapping = exact ?? recovered;
      if (mapping) {
        await tx.query(
          'SELECT order_id FROM orders WHERE order_id=$1 FOR UPDATE',
          [mapping.erpId],
        );
        const linkedRequest = mapping.sourceSystem === 'bitrix24'
          ? await tx.query<{
              request_id: string | number;
              state: string;
              sync_status: string;
              sync_error_code: string | null;
              archived_by_source: string | null;
              archived_order_version: number | null;
              client_id: string | number | null;
              title: string;
              crm_amount: string | number | null;
              currency_id: string | null;
              stage_id: string | null;
              assigned_by_id: string | null;
              begin_date: Date | string | null;
              close_date: Date | string | null;
              comments: string | null;
            }>(
              `SELECT request_id, state, sync_status, sync_error_code, archived_by_source,
                      archived_order_version, client_id, title, crm_amount,
                      currency_id, stage_id, assigned_by_id, begin_date,
                      close_date, comments
                 FROM bitrix24_incoming_request
                WHERE bitrix_deal_id=$1 AND linked_order_id=$2
                FOR UPDATE`,
              [snapshot.bitrixId, mapping.erpId],
            )
          : null;
        const linkedRequestId = linkedRequest?.rows[0]
          ? Number(linkedRequest.rows[0].request_id)
          : null;
        const linkedRequestRow = linkedRequest?.rows[0];
        let restoredFromArchive = false;
        if (
          linkedRequestRow?.state === 'archived' &&
          linkedRequestRow.archived_by_source === 'bitrix24' &&
          materialization
        ) {
          if (
            linkedRequestRow.sync_status === 'blocked' &&
            linkedRequestRow.sync_error_code === 'RESTORE_VERSION_CONFLICT' &&
            mapping.lastBitrixHash === snapshot.normalizedHash
          ) {
            return { requestId: linkedRequestId, erpOrderId: mapping.erpId };
          }
          const restored = await tx.query<{ version: number }>(
            `UPDATE orders
                SET delete_flag=false, deleted_at=NULL, deleted_by=NULL,
                    edited_by=$2, version=version+1
              WHERE order_id=$1
                AND order_kind='crm_request'
                AND delete_flag=true
                AND version=$3
              RETURNING version`,
            [mapping.erpId, materialization.actorUserId, linkedRequestRow.archived_order_version],
          );
          if (restored.rowCount !== 1) {
            const blocked = await tx.query<{ sync_version: string | number }>(
              `UPDATE bitrix24_incoming_request
                  SET sync_status='blocked', sync_error_code='RESTORE_VERSION_CONFLICT',
                      sync_error_at=now(), sync_version=sync_version+1,
                      version=version+1, updated_at=now()
                WHERE request_id=$1
                RETURNING sync_version`,
              [linkedRequestId],
            );
            const conflictVersion = Number(blocked.rows[0]?.sync_version ?? 0);
            await upsertMapping(tx, {
              entityType: 'order',
              erpId: mapping.erpId,
              bitrixObject: 'deal',
              bitrixId: snapshot.bitrixId,
              parentErpId: mapping.parentErpId,
              sourceSystem: mapping.sourceSystem,
              normalizedHash: snapshot.normalizedHash,
              bitrixUpdatedAt: snapshot.bitrixUpdatedAt,
            });
            await upsertRemoteState(tx, {
              objectType: 'deal',
              bitrixId: snapshot.bitrixId,
              erpEntityType: 'order',
              erpId: mapping.erpId,
              normalizedHash: snapshot.normalizedHash,
              remoteRevision: snapshot.remoteRevision,
              title: snapshot.fullTitle,
              crmAmount: snapshot.crmAmount,
              currencyId: snapshot.currencyId,
              stageId: snapshot.stageId,
              assignedById: snapshot.assignedById,
              beginDate: snapshot.beginDate,
              closeDate: snapshot.closeDate,
              comments: snapshot.comments,
              bitrixCreatedAt: snapshot.bitrixCreatedAt,
              bitrixUpdatedAt: snapshot.bitrixUpdatedAt,
              rawSnapshot: snapshot.rawSnapshot,
            });
            await recordSyncConflict(tx, this.audit, {
              orderId: Number(mapping.erpId),
              clientId: mapping.parentErpId ? Number(mapping.parentErpId) : null,
              requestId: Number(linkedRequestRow.request_id),
              bitrixDealId: snapshot.bitrixId,
              actorUserId: materialization.actorUserId,
              correlationId: requestId,
              syncVersion: conflictVersion,
              conflictCode: 'RESTORE_VERSION_CONFLICT',
            });
            return { requestId: linkedRequestId, erpOrderId: mapping.erpId };
          }
          const restoredRequest = await tx.query<{
            version: number;
            sync_version: string | number;
          }>(
            `UPDATE bitrix24_incoming_request
                SET state='active', archived_by_source=NULL, archived_at=NULL,
                    archived_order_version=NULL, sync_status='ok',
                    sync_error_code=NULL, sync_error_at=NULL,
                    sync_version=sync_version+1, version=version+1, updated_at=now()
              WHERE request_id=$1
              RETURNING version, sync_version`,
            [linkedRequestId],
          );
          await tx.query(
            `UPDATE crm_sync_mapping SET status='active', updated_at=now()
              WHERE entity_type='order' AND erp_id=$1`,
            [mapping.erpId],
          );
          await this.audit.record(tx, {
            event: 'orders.crm_request_restored',
            entityType: 'order',
            entityId: mapping.erpId,
            actorUserId: materialization.actorUserId,
            requestId,
            source: 'bitrix24',
            relatedOrderId: Number(mapping.erpId),
            relatedClientId: mapping.parentErpId ? Number(mapping.parentErpId) : null,
            after: { deleteFlag: false, requestState: 'active' },
            metadata: { bitrixDealId: snapshot.bitrixId },
          });
          await enqueueDomainEvent(tx, {
            eventType: 'orders.crm_request_restored',
            aggregateType: 'order',
            aggregateId: mapping.erpId,
            idempotencyKey:
              `crm-restore:${snapshot.bitrixId}:${restoredRequest.rows[0].sync_version}`,
            payload: {
              eventVersion: 1,
              eventName: 'orders.crm_request_restored',
              orderId: Number(mapping.erpId),
              clientId: mapping.parentErpId ? Number(mapping.parentErpId) : null,
              incomingRequestId: linkedRequestId,
              bitrixDealId: snapshot.bitrixId,
              actorType: 'service',
              actorUserId: materialization.actorUserId,
              sourceSystem: 'bitrix24',
              requestId,
            },
          });
          restoredFromArchive = true;
        }
        if (
          linkedRequestRow?.state === 'archived' &&
          linkedRequestRow.archived_by_source === 'erp_user'
        ) {
          if (mapping.lastBitrixHash === snapshot.normalizedHash) {
            return { requestId: linkedRequestId, erpOrderId: mapping.erpId };
          }
          const blocked = await tx.query<{ sync_version: string | number }>(
            `UPDATE bitrix24_incoming_request
                SET sync_status='blocked',
                    sync_error_code='ERP_USER_ARCHIVE_CONFLICT',
                    sync_error_at=now(), sync_version=sync_version+1,
                    version=version+1, updated_at=now()
              WHERE request_id=$1
              RETURNING sync_version`,
            [linkedRequestId],
          );
          const syncVersion = Number(blocked.rows[0]?.sync_version ?? 0);
          await upsertMapping(tx, {
            entityType: 'order',
            erpId: mapping.erpId,
            bitrixObject: 'deal',
            bitrixId: snapshot.bitrixId,
            parentErpId: mapping.parentErpId,
            sourceSystem: mapping.sourceSystem,
            normalizedHash: snapshot.normalizedHash,
            bitrixUpdatedAt: snapshot.bitrixUpdatedAt,
          });
          await upsertRemoteState(tx, {
            objectType: 'deal',
            bitrixId: snapshot.bitrixId,
            erpEntityType: 'order',
            erpId: mapping.erpId,
            normalizedHash: snapshot.normalizedHash,
            remoteRevision: snapshot.remoteRevision,
            title: snapshot.fullTitle,
            crmAmount: snapshot.crmAmount,
            currencyId: snapshot.currencyId,
            stageId: snapshot.stageId,
            assignedById: snapshot.assignedById,
            beginDate: snapshot.beginDate,
            closeDate: snapshot.closeDate,
            comments: snapshot.comments,
            bitrixCreatedAt: snapshot.bitrixCreatedAt,
            bitrixUpdatedAt: snapshot.bitrixUpdatedAt,
            rawSnapshot: snapshot.rawSnapshot,
          });
          await recordSyncConflict(tx, this.audit, {
            orderId: Number(mapping.erpId),
            clientId: mapping.parentErpId ? Number(mapping.parentErpId) : null,
            requestId: Number(linkedRequestRow.request_id),
            bitrixDealId: snapshot.bitrixId,
            actorUserId: materialization?.actorUserId ?? null,
            correlationId: requestId,
            syncVersion,
            conflictCode: 'ERP_USER_ARCHIVE_CONFLICT',
          });
          return { requestId: linkedRequestId, erpOrderId: mapping.erpId };
        }
        if (
          !restoredFromArchive && (
          (
            mapping.lastBitrixHash === snapshot.normalizedHash &&
            (
              linkedRequestRow?.sync_status !== 'blocked' ||
              (
                linkedRequestRow.sync_error_code === 'COUNTERPARTY_UNRESOLVED' &&
                snapshot.clientId === null
              )
            )
          ) ||
          (
            mapping.lastBitrixUpdatedAt &&
            snapshot.bitrixUpdatedAt &&
            snapshot.bitrixUpdatedAt < mapping.lastBitrixUpdatedAt
          )
          )
        ) {
          return { requestId: linkedRequestId, erpOrderId: mapping.erpId };
        }
        const requestIsActive = restoredFromArchive || linkedRequestRow?.state === 'active';
        let linkedRequestVersion: number | null = null;
        if (linkedRequestId !== null) {
          const managerId = materialization
            ? await resolveMappedManagerId(tx, snapshot.assignedById)
            : null;
          if (snapshot.clientId !== null) {
            await tx.query(
              `UPDATE orders
                  SET order_name=$2, client_id=$3,
                      order_date=COALESCE($4::date, order_date),
                      manager_id=$5, edited_by=$6, version=version+1
                WHERE order_id=$1
                  AND order_kind='crm_request'
                  AND delete_flag=false
                  AND project_id IS NULL`,
              [
                mapping.erpId,
                snapshot.title,
                snapshot.clientId,
                snapshot.beginDate,
                managerId,
                materialization?.actorUserId ?? null,
              ],
            );
          }
          const updatedRequest = await tx.query<{ version: number }>(
            `UPDATE bitrix24_incoming_request
                SET client_id=CASE WHEN state='active' THEN COALESCE($2, client_id)
                                   ELSE client_id END,
                    title=$3, crm_amount=$4, currency_id=$5,
                    stage_id=$6, assigned_by_id=$7, begin_date=$8,
                    close_date=$9, comments=$10, bitrix_url=$11,
                    bitrix_created_at=$12, bitrix_updated_at=$13,
                    counterparty_object_type=CASE
                      WHEN state='active' AND $2::bigint IS NOT NULL THEN $14
                      ELSE counterparty_object_type
                    END,
                    counterparty_bitrix_id=CASE
                      WHEN state='active' AND $2::bigint IS NOT NULL THEN $15
                      ELSE counterparty_bitrix_id
                    END,
                    full_title=$16, remote_revision=$17,
                    sync_status=CASE
                      WHEN state='active' AND $2::bigint IS NULL THEN 'blocked'
                      WHEN state='active' THEN 'ok'
                      ELSE sync_status
                    END,
                    sync_error_code=CASE
                      WHEN state='active' AND $2::bigint IS NULL
                        THEN 'COUNTERPARTY_UNRESOLVED'
                      WHEN state='active' THEN NULL
                      ELSE sync_error_code
                    END,
                    sync_error_at=CASE
                      WHEN state='active' AND $2::bigint IS NULL THEN now()
                      WHEN state='active' THEN NULL
                      ELSE sync_error_at
                    END,
                    sync_version=sync_version+1,
                    version=version+1, updated_at=now()
              WHERE request_id=$1
              RETURNING version`,
            [
              linkedRequestId,
              snapshot.clientId,
              snapshot.title,
              snapshot.crmAmount,
              snapshot.currencyId,
              snapshot.stageId,
              snapshot.assignedById,
              snapshot.beginDate,
              snapshot.closeDate,
              snapshot.comments,
              snapshot.bitrixUrl,
              snapshot.bitrixCreatedAt,
              snapshot.bitrixUpdatedAt,
              snapshot.counterpartyObjectType,
              snapshot.counterpartyBitrixId,
              snapshot.fullTitle,
              snapshot.remoteRevision,
            ],
          );
          linkedRequestVersion = updatedRequest.rows[0]?.version ?? null;
        }
        const nextParentErpId =
          requestIsActive && snapshot.clientId !== null
            ? String(snapshot.clientId)
            : mapping.parentErpId;
        await upsertMapping(tx, {
          entityType: 'order',
          erpId: mapping.erpId,
          bitrixObject: 'deal',
          bitrixId: snapshot.bitrixId,
          parentErpId: nextParentErpId,
          sourceSystem: mapping.sourceSystem,
          normalizedHash: snapshot.normalizedHash,
          bitrixUpdatedAt: snapshot.bitrixUpdatedAt,
        });
        await upsertRemoteState(tx, {
          objectType: 'deal',
          bitrixId: snapshot.bitrixId,
          erpEntityType: 'order',
          erpId: mapping.erpId,
          normalizedHash: snapshot.normalizedHash,
          remoteRevision: snapshot.remoteRevision,
          title: snapshot.fullTitle,
          crmAmount: snapshot.crmAmount,
          currencyId: snapshot.currencyId,
          stageId: snapshot.stageId,
          assignedById: snapshot.assignedById,
          beginDate: snapshot.beginDate,
          closeDate: snapshot.closeDate,
          comments: snapshot.comments,
          bitrixCreatedAt: snapshot.bitrixCreatedAt,
          bitrixUpdatedAt: snapshot.bitrixUpdatedAt,
          rawSnapshot: snapshot.rawSnapshot,
        });
        if (linkedRequestId !== null && linkedRequestVersion !== null) {
          const before = incomingRequestAuditFields(linkedRequestRow);
          const after = incomingRequestAuditFields({
            ...linkedRequestRow,
            client_id:
              requestIsActive && snapshot.clientId !== null
                ? snapshot.clientId
                : linkedRequestRow?.client_id ?? null,
            title: snapshot.title,
            crm_amount: snapshot.crmAmount,
            currency_id: snapshot.currencyId,
            stage_id: snapshot.stageId,
            assigned_by_id: snapshot.assignedById,
            comments: snapshot.comments,
            sync_status:
              requestIsActive && snapshot.clientId === null
                ? 'blocked'
                : linkedRequestRow?.state === 'active'
                  ? 'ok'
                  : linkedRequestRow?.sync_status ?? 'ok',
          });
          if (requestIsActive && snapshot.clientId === null) {
            await recordSyncConflict(tx, this.audit, {
              orderId: Number(mapping.erpId),
              clientId: mapping.parentErpId ? Number(mapping.parentErpId) : null,
              requestId: linkedRequestId,
              bitrixDealId: snapshot.bitrixId,
              actorUserId: materialization?.actorUserId ?? null,
              correlationId: requestId,
              syncVersion: linkedRequestVersion,
              conflictCode: 'COUNTERPARTY_UNRESOLVED',
            });
          } else {
            await recordCrmRequestUpdated(tx, this.audit, {
              orderId: Number(mapping.erpId),
              clientId: nextParentErpId ? Number(nextParentErpId) : null,
              requestId: linkedRequestId,
              bitrixDealId: snapshot.bitrixId,
              actorType: 'service',
              actorUserId: materialization?.actorUserId ?? null,
              sourceSystem: 'bitrix24',
              correlationId: requestId,
              mutationVersion: snapshot.remoteRevision || String(linkedRequestVersion),
              before,
              after,
            });
          }
        } else {
          await this.audit.record(tx, {
            event: 'bitrix24_reverse.deal_state_upsert',
            entityType: 'order',
            entityId: mapping.erpId,
            actorUserId: materialization?.actorUserId ?? null,
            requestId,
            source: 'bitrix24',
            relatedOrderId: Number(mapping.erpId),
            relatedClientId: nextParentErpId ? Number(nextParentErpId) : null,
            after: {
              crmAmount: snapshot.crmAmount,
              currencyId: snapshot.currencyId,
              stageId: snapshot.stageId,
              assignedById: snapshot.assignedById,
            },
            metadata: { bitrixObject: 'deal', bitrixId: snapshot.bitrixId },
          });
        }
        return { requestId: linkedRequestId, erpOrderId: mapping.erpId };
      }

      if (snapshot.originErpOrderId) {
        const originOrder = await tx.query<{ order_id: string | number; client_id: string | number }>(
          `SELECT order_id, client_id
             FROM orders
            WHERE order_id=$1 AND order_kind='production_order'
            FOR UPDATE`,
          [snapshot.originErpOrderId],
        );
        const originRow = originOrder.rows[0];
        if (originRow) {
          await upsertMapping(tx, {
            entityType: 'order',
            erpId: String(originRow.order_id),
            bitrixObject: 'deal',
            bitrixId: snapshot.bitrixId,
            parentErpId: String(originRow.client_id),
            sourceSystem: 'erp',
            normalizedHash: snapshot.normalizedHash,
            bitrixUpdatedAt: snapshot.bitrixUpdatedAt,
          });
          await upsertRemoteState(tx, {
            objectType: 'deal',
            bitrixId: snapshot.bitrixId,
            erpEntityType: 'order',
            erpId: String(originRow.order_id),
            normalizedHash: snapshot.normalizedHash,
            remoteRevision: snapshot.remoteRevision,
            title: snapshot.fullTitle,
            crmAmount: snapshot.crmAmount,
            currencyId: snapshot.currencyId,
            stageId: snapshot.stageId,
            assignedById: snapshot.assignedById,
            beginDate: snapshot.beginDate,
            closeDate: snapshot.closeDate,
            comments: snapshot.comments,
            bitrixCreatedAt: snapshot.bitrixCreatedAt,
            bitrixUpdatedAt: snapshot.bitrixUpdatedAt,
            rawSnapshot: snapshot.rawSnapshot,
          });
          return { requestId: null, erpOrderId: String(originRow.order_id) };
        }
        throw conflict(
          'BITRIX24_ERP_ORIGIN_ORDER_MISSING',
          'Bitrix24 Deal declares ERP origin but the ERP order does not exist',
        );
      }

      if (materialization && snapshot.clientId !== null) {
        return materializeCrmRequestOrder(
          tx,
          this.audit,
          snapshot,
          materialization,
          requestId,
        );
      }

      const existing = await tx.query<{
        request_id: string | number;
        bitrix_updated_at: Date | string | null;
        normalized_hash: string | null;
      }>(
        `SELECT request.request_id, request.bitrix_updated_at, state.normalized_hash
           FROM bitrix24_incoming_request request
           LEFT JOIN bitrix24_remote_state state
             ON state.object_type='deal' AND state.bitrix_id=request.bitrix_deal_id
          WHERE request.bitrix_deal_id=$1`,
        [snapshot.bitrixId],
      );
      const existingRow = existing.rows[0];
      if (
        existingRow?.normalized_hash === snapshot.normalizedHash ||
        (
          existingRow?.bitrix_updated_at &&
          snapshot.bitrixUpdatedAt &&
          snapshot.bitrixUpdatedAt < new Date(existingRow.bitrix_updated_at)
        )
      ) {
        return { requestId: Number(existingRow.request_id), erpOrderId: null };
      }

      const result = await tx.query<{
        request_id: string | number;
        version: number;
      }>(
        `INSERT INTO bitrix24_incoming_request (
           bitrix_deal_id, client_id, title, crm_amount, currency_id,
           stage_id, assigned_by_id, begin_date, close_date, comments,
           bitrix_url, state, bitrix_created_at, bitrix_updated_at,
           counterparty_object_type, counterparty_bitrix_id, full_title,
           remote_revision, sync_status
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unresolved',$12,$13,$14,$15,$16,$17,'ok')
         ON CONFLICT (bitrix_deal_id) DO UPDATE SET
           client_id=EXCLUDED.client_id, title=EXCLUDED.title,
           crm_amount=EXCLUDED.crm_amount, currency_id=EXCLUDED.currency_id,
           stage_id=EXCLUDED.stage_id, assigned_by_id=EXCLUDED.assigned_by_id,
           begin_date=EXCLUDED.begin_date, close_date=EXCLUDED.close_date,
           comments=EXCLUDED.comments, bitrix_url=EXCLUDED.bitrix_url,
           bitrix_created_at=EXCLUDED.bitrix_created_at,
           bitrix_updated_at=EXCLUDED.bitrix_updated_at,
           counterparty_object_type=EXCLUDED.counterparty_object_type,
           counterparty_bitrix_id=EXCLUDED.counterparty_bitrix_id,
           full_title=EXCLUDED.full_title,
           remote_revision=EXCLUDED.remote_revision,
           state='unresolved', sync_status='ok', sync_error_code=NULL,
           sync_error_at=NULL, sync_version=bitrix24_incoming_request.sync_version+1,
           version=bitrix24_incoming_request.version+1, updated_at=now()
         RETURNING request_id, version`,
        [
          snapshot.bitrixId,
          snapshot.clientId,
          snapshot.title,
          snapshot.crmAmount,
          snapshot.currencyId,
          snapshot.stageId,
          snapshot.assignedById,
          snapshot.beginDate,
          snapshot.closeDate,
          snapshot.comments,
          snapshot.bitrixUrl,
          snapshot.bitrixCreatedAt,
          snapshot.bitrixUpdatedAt,
          snapshot.counterpartyObjectType,
          snapshot.counterpartyBitrixId,
          snapshot.fullTitle,
          snapshot.remoteRevision,
        ],
      );
      const incomingRequestId = Number(result.rows[0].request_id);
      await upsertRemoteState(tx, {
        objectType: 'deal',
        bitrixId: snapshot.bitrixId,
        erpEntityType: null,
        erpId: null,
        normalizedHash: snapshot.normalizedHash,
        remoteRevision: snapshot.remoteRevision,
        title: snapshot.fullTitle,
        crmAmount: snapshot.crmAmount,
        currencyId: snapshot.currencyId,
        stageId: snapshot.stageId,
        assignedById: snapshot.assignedById,
        beginDate: snapshot.beginDate,
        closeDate: snapshot.closeDate,
        comments: snapshot.comments,
        bitrixCreatedAt: snapshot.bitrixCreatedAt,
        bitrixUpdatedAt: snapshot.bitrixUpdatedAt,
        rawSnapshot: snapshot.rawSnapshot,
      });
      await this.audit.record(tx, {
        event: 'bitrix24_reverse.incoming_request_upsert',
        entityType: 'bitrix24_incoming_request',
        entityId: incomingRequestId,
        actorUserId: null,
        requestId,
        source: 'bitrix24',
        relatedClientId: snapshot.clientId,
        after: {
          title: snapshot.title,
          crmAmount: snapshot.crmAmount,
          currencyId: snapshot.currencyId,
          stageId: snapshot.stageId,
          assignedById: snapshot.assignedById,
        },
        metadata: { bitrixDealId: snapshot.bitrixId },
      });
      await enqueueDomainEvent(tx, {
        eventType: 'bitrix24.incoming_request.upserted',
        aggregateType: 'bitrix24_incoming_request',
        aggregateId: String(incomingRequestId),
        idempotencyKey:
          `bitrix24.incoming_request.upserted:${incomingRequestId}:${result.rows[0].version}`,
        payload: {
          requestId: incomingRequestId,
          bitrixDealId: snapshot.bitrixId,
          clientId: snapshot.clientId,
          stageId: snapshot.stageId,
          requestCorrelationId: requestId,
          source: 'bitrix24',
        },
      });
      return { requestId: incomingRequestId, erpOrderId: null };
    });
  }

  async archiveDeal(
    bitrixId: string,
    requestId: string,
    lockToken?: string,
    actorUserId?: number,
  ): Promise<boolean> {
    const discovery = await this.db.query<{
      request_id: string | number;
      state: string;
      linked_order_id: string | number | null;
      client_id: string | number | null;
    }>(
      `SELECT request_id, state, linked_order_id, client_id
         FROM bitrix24_incoming_request
        WHERE bitrix_deal_id=$1`,
      [bitrixId],
    );
    const discovered = discovery.rows[0];
    if (!discovered || discovered.state === 'archived') return false;

    return this.db.transaction(async (tx) => {
      await assertInboundOwnership(tx, requestId, lockToken);
      await lockAggregate(tx, `deal:${bitrixId}`);
      await setReverseOrigin(tx);
      if (await consumeSuppression(tx, 'deal', bitrixId, 'delete')) return false;
      if (discovered.linked_order_id !== null) {
        const order = await tx.query(
          'SELECT order_id FROM orders WHERE order_id=$1 FOR UPDATE',
          [discovered.linked_order_id],
        );
        if (order.rowCount !== 1) {
          throw notFound('ORDER_NOT_FOUND', 'Order not found');
        }
      }
      const request = await tx.query<{
        request_id: string | number;
        state: string;
        linked_order_id: string | number | null;
        client_id: string | number | null;
      }>(
        `SELECT request_id, state, linked_order_id, client_id
           FROM bitrix24_incoming_request
          WHERE bitrix_deal_id=$1 AND request_id=$2
          FOR UPDATE`,
        [bitrixId, discovered.request_id],
      );
      const row = request.rows[0];
      if (!row || row.state === 'archived') return false;
      if (row.linked_order_id !== discovered.linked_order_id) {
        throw conflict('BITRIX24_REQUEST_CHANGED', 'Bitrix24 incoming request changed');
      }
      let archivedOrderVersion: number | null = null;
      if (row.state === 'active' && row.linked_order_id !== null) {
        if (!actorUserId) {
          throw new ApiError(503, 'BITRIX24_REVERSE_ACTOR_MISSING', 'Bitrix24 service actor is required');
        }
        const archived = await tx.query<{ version: number }>(
          `UPDATE orders
              SET delete_flag=true, deleted_at=now(), deleted_by=$2,
                  edited_by=$2, version=version+1
            WHERE order_id=$1 AND order_kind='crm_request' AND delete_flag=false
            RETURNING version`,
          [row.linked_order_id, actorUserId],
        );
        archivedOrderVersion = archived.rows[0]?.version ?? null;
      }
      const archivedRequest = await tx.query<{
        version: number;
        sync_version: string | number;
      }>(
        `UPDATE bitrix24_incoming_request
            SET state='archived', archived_by_source='bitrix24', archived_at=now(),
                archived_order_version=$2, version=version+1,
                sync_status=CASE WHEN state='converted' THEN 'blocked' ELSE sync_status END,
                sync_error_code=CASE
                  WHEN state='converted' THEN 'REMOTE_DEAL_DELETED'
                  ELSE sync_error_code
                END,
                sync_error_at=CASE WHEN state='converted' THEN now() ELSE sync_error_at END,
                sync_version=sync_version+1, updated_at=now()
          WHERE request_id=$1
          RETURNING version, sync_version`,
        [row.request_id, archivedOrderVersion],
      );
      if (row.state === 'converted' && row.linked_order_id !== null) {
        await tx.query(
          `UPDATE crm_sync_mapping
              SET status='remote_deleted', updated_at=now(), last_synced_at=now()
            WHERE entity_type='order' AND erp_id=$1`,
          [row.linked_order_id],
        );
        await recordSyncConflict(tx, this.audit, {
          orderId: Number(row.linked_order_id),
          clientId: row.client_id === null ? null : Number(row.client_id),
          requestId: Number(row.request_id),
          bitrixDealId: bitrixId,
          actorUserId: actorUserId ?? null,
          correlationId: requestId,
          syncVersion: Number(archivedRequest.rows[0].sync_version),
          conflictCode: 'REMOTE_DEAL_DELETED',
        });
      }
      await tx.query(
        `UPDATE bitrix24_remote_state
            SET is_deleted=true, deleted_at=now(), last_applied_at=now()
          WHERE object_type='deal' AND bitrix_id=$1`,
        [bitrixId],
      );
      await this.audit.record(tx, {
        event: 'orders.crm_request_archived',
        entityType: row.linked_order_id === null ? 'bitrix24_incoming_request' : 'order',
        entityId: row.linked_order_id ?? row.request_id,
        actorUserId: actorUserId ?? null,
        requestId,
        source: 'bitrix24',
        relatedOrderId: row.linked_order_id === null ? null : Number(row.linked_order_id),
        relatedClientId: row.client_id === null ? null : Number(row.client_id),
        after: { requestState: 'archived', archivedBySource: 'bitrix24' },
        metadata: { bitrixDealId: bitrixId, previousState: row.state },
      });
      await enqueueDomainEvent(tx, {
        eventType: 'orders.crm_request_archived',
        aggregateType:
          row.linked_order_id === null ? 'bitrix24_incoming_request' : 'order',
        aggregateId: String(row.linked_order_id ?? row.request_id),
        idempotencyKey:
          `crm-archive:${bitrixId}:${archivedRequest.rows[0].sync_version}`,
        payload: {
          eventVersion: 1,
          eventName: 'orders.crm_request_archived',
          orderId: row.linked_order_id === null ? null : Number(row.linked_order_id),
          clientId: row.client_id === null ? null : Number(row.client_id),
          incomingRequestId: Number(row.request_id),
          bitrixDealId: bitrixId,
          actorType: 'service',
          actorUserId: actorUserId ?? null,
          sourceSystem: 'bitrix24',
          archivedBySource: 'bitrix24',
          requestId,
        },
      });
      return true;
    });
  }

  async replaceRequestPaymentSnapshots(
    incomingRequestId: number,
    payments: ReversePaymentSnapshot[],
    auditRequestId: string,
    lockToken?: string,
  ): Promise<void> {
    const owner = await this.db.query<{
      bitrix_deal_id: string;
      linked_order_id: string | number | null;
    }>(
      `SELECT bitrix_deal_id, linked_order_id
         FROM bitrix24_incoming_request
        WHERE request_id=$1`,
      [incomingRequestId],
    );
    const discovered = owner.rows[0];
    if (!discovered) {
      throw notFound('BITRIX24_REQUEST_NOT_FOUND', 'Bitrix24 incoming request not found');
    }
    await this.db.transaction(async (tx) => {
      await assertInboundOwnership(tx, auditRequestId, lockToken);
      await lockAggregate(tx, `deal:${discovered.bitrix_deal_id}`);
      await setReverseOrigin(tx);
      if (discovered.linked_order_id !== null) {
        await tx.query('SELECT order_id FROM orders WHERE order_id=$1 FOR UPDATE', [
          discovered.linked_order_id,
        ]);
      }
      const lockedRequest = await tx.query(
        `SELECT request_id
           FROM bitrix24_incoming_request
          WHERE request_id=$1 AND bitrix_deal_id=$2
          FOR UPDATE`,
        [incomingRequestId, discovered.bitrix_deal_id],
      );
      if (lockedRequest.rowCount !== 1) {
        throw conflict('BITRIX24_REQUEST_CHANGED', 'Bitrix24 incoming request changed');
      }
      const activeIds = payments.map((payment) => payment.bitrixPaymentId);
      await assertPaymentSnapshotOwnership(tx, activeIds, {
        requestId: incomingRequestId,
        orderId: null,
      });
      await tx.query(
        `UPDATE bitrix24_incoming_request_payment
            SET state='deleted', updated_at=now()
          WHERE request_id=$1
            AND state IN ('active','materialized')
            AND NOT (bitrix_payment_id = ANY($2::text[]))`,
        [incomingRequestId, activeIds],
      );
      for (const payment of payments) {
        await tx.query(
          `INSERT INTO bitrix24_incoming_request_payment (
             bitrix_payment_id, request_id, erp_order_id,
             pay_system_id, pay_system_name,
             amount, currency_id, paid, payment_date, normalized_hash, state,
             bitrix_created_at, bitrix_updated_at, last_fetched_at, updated_at
           )
           VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,now(),now())
           ON CONFLICT (bitrix_payment_id) DO UPDATE SET
             request_id=EXCLUDED.request_id,
             erp_order_id=NULL,
             pay_system_id=EXCLUDED.pay_system_id,
             pay_system_name=EXCLUDED.pay_system_name,
             amount=EXCLUDED.amount, currency_id=EXCLUDED.currency_id,
             paid=EXCLUDED.paid, payment_date=EXCLUDED.payment_date,
             normalized_hash=EXCLUDED.normalized_hash,
             sync_version=bitrix24_incoming_request_payment.sync_version+1,
             state=CASE
               WHEN bitrix24_incoming_request_payment.erp_payment_id IS NOT NULL
                 THEN 'materialized'
               ELSE 'active'
             END,
             bitrix_created_at=EXCLUDED.bitrix_created_at,
             bitrix_updated_at=EXCLUDED.bitrix_updated_at,
             last_fetched_at=now(), updated_at=now()`,
          [
            payment.bitrixPaymentId,
            incomingRequestId,
            payment.paySystemId,
            payment.paySystemName,
            payment.amount,
            payment.currencyId,
            payment.paid,
            payment.paymentDate,
            payment.normalizedHash,
            payment.bitrixCreatedAt,
            payment.bitrixUpdatedAt,
          ],
        );
      }
      await this.audit.record(tx, {
        event: 'bitrix24_reverse.request_payments_reconcile',
        entityType: 'bitrix24_incoming_request',
        entityId: incomingRequestId,
        actorUserId: null,
        requestId: auditRequestId,
        source: 'bitrix24',
        after: {
          activePaymentCount: payments.length,
          activePaymentAmount: payments.reduce((sum, payment) => sum + payment.amount, 0),
        },
      });
    });
  }

  async archiveIncomingRequest(input: {
    requestId: number;
    expectedVersion: number;
    actorUserId: number;
    actorUsername: string;
    actorRole: string;
    auditRequestId: string;
    scope: { mode: 'all' } | { mode: 'assigned'; userId: number };
  }): Promise<Record<string, unknown>> {
    const discovery = await this.db.query<{
      bitrix_deal_id: string;
      linked_order_id: string | number | null;
      manager_id: string | number | null;
    }>(
      `SELECT request.bitrix_deal_id, request.linked_order_id, orders.manager_id
         FROM bitrix24_incoming_request request
         LEFT JOIN orders ON orders.order_id=request.linked_order_id
        WHERE request.request_id=$1
          AND ($2::boolean OR orders.manager_id=$3)`,
      [
        input.requestId,
        input.scope.mode === 'all',
        input.scope.mode === 'assigned' ? input.scope.userId : null,
      ],
    );
    const discovered = discovery.rows[0];
    if (!discovered || discovered.linked_order_id === null) {
      throw notFound('BITRIX24_REQUEST_NOT_FOUND', 'Bitrix24 incoming request not found');
    }
    const orderId = Number(discovered.linked_order_id);
    let archivedOrderVersion = 0;
    await this.db.transaction(async (tx) => {
      await lockAggregate(tx, `deal:${discovered.bitrix_deal_id}`);
      await setReverseOrigin(tx);
      const order = await tx.query<{
        version: number;
        client_id: string | number;
      }>(
        `SELECT version, client_id
           FROM orders
          WHERE order_id=$1 AND order_kind='crm_request'
            AND project_id IS NULL AND delete_flag=false
            AND ($2::boolean OR manager_id=$3)
          FOR UPDATE`,
        [
          orderId,
          input.scope.mode === 'all',
          input.scope.mode === 'assigned' ? input.scope.userId : null,
        ],
      );
      const orderRow = order.rows[0];
      if (!orderRow) {
        throw notFound('BITRIX24_REQUEST_NOT_FOUND', 'Bitrix24 incoming request not found');
      }
      if (orderRow.version !== input.expectedVersion) {
        throw conflict('ORDER_VERSION_CONFLICT', 'CRM request order version changed');
      }
      const request = await tx.query<{
        state: string;
      }>(
        `SELECT state
           FROM bitrix24_incoming_request
          WHERE request_id=$1 AND linked_order_id=$2 AND bitrix_deal_id=$3
          FOR UPDATE`,
        [input.requestId, orderId, discovered.bitrix_deal_id],
      );
      if (request.rows[0]?.state !== 'active') {
        throw conflict('BITRIX24_REQUEST_NOT_EDITABLE', 'Only active CRM requests can be archived');
      }
      const archivedOrder = await tx.query<{ version: number }>(
        `UPDATE orders
            SET delete_flag=true, deleted_at=now(), deleted_by=$2,
                edited_by=$2, version=version+1
          WHERE order_id=$1
          RETURNING version`,
        [orderId, input.actorUserId],
      );
      archivedOrderVersion = archivedOrder.rows[0].version;
      const archivedRequest = await tx.query<{ sync_version: string | number }>(
        `UPDATE bitrix24_incoming_request
            SET state='archived', archived_by_source='erp_user', archived_at=now(),
                archived_order_version=$2, sync_status='ok',
                sync_error_code=NULL, sync_error_at=NULL,
                sync_version=sync_version+1, version=version+1, updated_at=now()
          WHERE request_id=$1
          RETURNING sync_version`,
        [input.requestId, archivedOrderVersion],
      );
      await this.audit.record(tx, {
        event: 'orders.crm_request_archived',
        entityType: 'order',
        entityId: orderId,
        actorUserId: input.actorUserId,
        actorUsername: input.actorUsername,
        actorRole: input.actorRole,
        requestId: input.auditRequestId,
        source: 'backend-bitrix24',
        relatedOrderId: orderId,
        relatedClientId: Number(orderRow.client_id),
        before: { deleteFlag: false, requestState: 'active' },
        after: { deleteFlag: true, requestState: 'archived' },
        metadata: {
          bitrixDealId: discovered.bitrix_deal_id,
          archivedBySource: 'erp_user',
          archivedOrderVersion,
        },
      });
      await enqueueDomainEvent(tx, {
        eventType: 'orders.crm_request_archived',
        aggregateType: 'order',
        aggregateId: String(orderId),
        idempotencyKey:
          `crm-archive:${discovered.bitrix_deal_id}:${archivedRequest.rows[0].sync_version}`,
        payload: {
          eventVersion: 1,
          eventName: 'orders.crm_request_archived',
          orderId,
          clientId: Number(orderRow.client_id),
          incomingRequestId: input.requestId,
          bitrixDealId: discovered.bitrix_deal_id,
          actorType: 'erp_user',
          actorUserId: input.actorUserId,
          sourceSystem: 'erp',
          archivedBySource: 'erp_user',
          requestId: input.auditRequestId,
        },
      });
    });
    return {
      requestId: input.requestId,
      orderId,
      state: 'archived',
      archivedBySource: 'erp_user',
      orderVersion: archivedOrderVersion,
    };
  }

  async replaceMappedOrderPaymentSnapshots(
    orderId: number,
    payments: ReversePaymentSnapshot[],
    auditRequestId: string,
    lockToken?: string,
  ): Promise<void> {
    const owner = await this.db.query<{ bitrix_id: string }>(
      `SELECT bitrix_id
         FROM crm_sync_mapping
        WHERE entity_type='order' AND erp_id=$1
          AND bitrix_object='deal' AND bitrix_id IS NOT NULL`,
      [String(orderId)],
    );
    const bitrixDealId = owner.rows[0]?.bitrix_id;
    if (!bitrixDealId) {
      throw conflict('BITRIX24_DEAL_MAPPING_MISSING', 'Bitrix24 Deal mapping is missing');
    }
    await this.db.transaction(async (tx) => {
      await assertInboundOwnership(tx, auditRequestId, lockToken);
      await lockAggregate(tx, `deal:${bitrixDealId}`);
      await setReverseOrigin(tx);
      const lockedOrder = await tx.query(
        'SELECT order_id FROM orders WHERE order_id=$1 FOR UPDATE',
        [orderId],
      );
      if (lockedOrder.rowCount !== 1) {
        throw notFound('ORDER_NOT_FOUND', 'Order not found');
      }
      const activeIds = payments.map((payment) => payment.bitrixPaymentId);
      await assertPaymentSnapshotOwnership(tx, activeIds, {
        requestId: null,
        orderId,
      });
      await tx.query(
        `UPDATE bitrix24_incoming_request_payment
            SET state='deleted', updated_at=now()
          WHERE erp_order_id=$1
            AND state IN ('active','materialized')
            AND NOT (bitrix_payment_id = ANY($2::text[]))`,
        [orderId, activeIds],
      );
      for (const payment of payments) {
        await tx.query(
          `INSERT INTO bitrix24_incoming_request_payment (
             bitrix_payment_id, request_id, erp_order_id,
             pay_system_id, pay_system_name, amount, currency_id, paid,
             payment_date, normalized_hash, state, bitrix_created_at,
             bitrix_updated_at, last_fetched_at, updated_at
           )
           VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,now(),now())
           ON CONFLICT (bitrix_payment_id) DO UPDATE SET
             erp_order_id=EXCLUDED.erp_order_id,
             request_id=NULL,
             pay_system_id=EXCLUDED.pay_system_id,
             pay_system_name=EXCLUDED.pay_system_name,
             amount=EXCLUDED.amount, currency_id=EXCLUDED.currency_id,
             paid=EXCLUDED.paid, payment_date=EXCLUDED.payment_date,
             normalized_hash=EXCLUDED.normalized_hash,
             sync_version=bitrix24_incoming_request_payment.sync_version+1,
             state=CASE
               WHEN bitrix24_incoming_request_payment.erp_payment_id IS NOT NULL
                 THEN 'materialized'
               ELSE 'active'
             END,
             bitrix_created_at=EXCLUDED.bitrix_created_at,
             bitrix_updated_at=EXCLUDED.bitrix_updated_at,
             last_fetched_at=now(), updated_at=now()`,
          [
            payment.bitrixPaymentId,
            orderId,
            payment.paySystemId,
            payment.paySystemName,
            payment.amount,
            payment.currencyId,
            payment.paid,
            payment.paymentDate,
            payment.normalizedHash,
            payment.bitrixCreatedAt,
            payment.bitrixUpdatedAt,
          ],
        );
      }
      await this.audit.record(tx, {
        event: 'bitrix24_reverse.order_payments_reconcile',
        entityType: 'order',
        entityId: orderId,
        actorUserId: null,
        requestId: auditRequestId,
        source: 'bitrix24',
        relatedOrderId: orderId,
        after: {
          activePaymentCount: payments.length,
          activePaymentAmount: payments.reduce((sum, payment) => sum + payment.amount, 0),
        },
      });
    });
  }

  async enqueueNextDealReconcileBatch(input: {
    batchSize: number;
    intervalMs: number;
  }): Promise<number> {
    return this.db.transaction(async (tx) => {
      const backlog = await tx.query<{ count: string | number }>(
        `SELECT COUNT(*) AS count
           FROM bitrix24_inbound_event
          WHERE status IN ('pending','processing','failed')`,
      );
      if (Number(backlog.rows[0]?.count ?? 0) >= input.batchSize * 4) return 0;

      const cursor = await tx.query<{
        last_bitrix_id: string | number;
        cycle_id: string;
        next_cycle_at: Date | string;
      }>(
        `SELECT last_bitrix_id, cycle_id, next_cycle_at
           FROM bitrix24_reconcile_cursor
          WHERE scope='deal_payments'
          FOR UPDATE`,
      );
      const state = cursor.rows[0];
      if (!state) throw new Error('Bitrix24 reconcile cursor is missing');
      const lastBitrixId = Number(state.last_bitrix_id);
      if (lastBitrixId === 0 && new Date(state.next_cycle_at).getTime() > Date.now()) {
        return 0;
      }
      const installation = await tx.query<{ member_id: string }>(
        `SELECT member_id
           FROM bitrix24_app_installation
          WHERE status <> 'revoked'
          ORDER BY updated_at DESC
          LIMIT 1`,
      );
      const memberId = installation.rows[0]?.member_id;
      if (!memberId) return 0;

      const deals = await tx.query<{ bitrix_id: string }>(
        `SELECT candidate.bitrix_id
           FROM (
             SELECT mapping.bitrix_id
               FROM crm_sync_mapping mapping
              WHERE mapping.entity_type='order'
                AND mapping.bitrix_object='deal'
                AND mapping.status='active'
                AND mapping.bitrix_id IS NOT NULL
                AND mapping.bitrix_id::bigint > $1
             UNION
             SELECT request.bitrix_deal_id
               FROM bitrix24_incoming_request request
              WHERE request.state <> 'archived'
                AND request.bitrix_deal_id::bigint > $1
           ) candidate
          ORDER BY candidate.bitrix_id::bigint
          LIMIT $2`,
        [lastBitrixId, input.batchSize],
      );
      if (deals.rows.length === 0) {
        await tx.query(
          `UPDATE bitrix24_reconcile_cursor
              SET last_bitrix_id=0, cycle_id=gen_random_uuid(),
                  next_cycle_at=now() + ($1::int * interval '1 millisecond'),
                  last_cycle_at=now(), updated_at=now()
            WHERE scope='deal_payments'`,
          [input.intervalMs],
        );
        return 0;
      }

      for (const deal of deals.rows) {
        const fingerprint =
          `reconcile:${state.cycle_id}:deal:${deal.bitrix_id}`;
        await tx.query(
          `INSERT INTO bitrix24_inbound_event (
             member_id, event_name, object_type, bitrix_id, event_ts,
             payload_json, fingerprint
           )
           VALUES ($1,'BITRIX24_RECONCILE_DEAL','deal',$2,now(),
                   jsonb_build_object('source','scheduled-reconcile'),$3)
           ON CONFLICT (member_id, fingerprint) DO NOTHING`,
          [memberId, deal.bitrix_id, fingerprint],
        );
      }
      const last = deals.rows.at(-1)?.bitrix_id;
      await tx.query(
        `UPDATE bitrix24_reconcile_cursor
            SET last_bitrix_id=$1, updated_at=now()
          WHERE scope='deal_payments'`,
        [last],
      );
      return deals.rows.length;
    });
  }

  async listIncomingRequests(input: {
    state?: 'unresolved' | 'active' | 'converted' | 'archived';
    search?: string;
    stageId?: string;
    assignedById?: string;
    clientId?: number;
    updatedFrom?: Date;
    updatedTo?: Date;
    page: number;
    pageSize: number;
    scope: { mode: 'all' } | { mode: 'assigned'; userId: number };
    canViewFinancials: boolean;
  }): Promise<{
    data: Array<Record<string, unknown>>;
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  }> {
    const offset = (input.page - 1) * input.pageSize;
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (input.scope.mode === 'assigned') {
      conditions.push(`linked_order.manager_id=$${params.push(input.scope.userId)}`);
    }
    if (input.state) {
      conditions.push(`request.state=$${params.push(input.state)}`);
    }
    if (input.search) {
      const parameter = `$${params.push(`%${input.search}%`)}`;
      conditions.push(
        `(request.title ILIKE ${parameter} OR client.client_name ILIKE ${parameter})`,
      );
    }
    if (input.stageId) {
      conditions.push(`request.stage_id=$${params.push(input.stageId)}`);
    }
    if (input.assignedById) {
      conditions.push(`request.assigned_by_id=$${params.push(input.assignedById)}`);
    }
    if (input.clientId) {
      conditions.push(`request.client_id=$${params.push(input.clientId)}`);
    }
    if (input.updatedFrom) {
      conditions.push(`request.bitrix_updated_at >= $${params.push(input.updatedFrom)}`);
    }
    if (input.updatedTo) {
      conditions.push(`request.bitrix_updated_at <= $${params.push(input.updatedTo)}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(input.pageSize, offset);
    const result = await this.db.query<{
      request_id: string | number;
      bitrix_deal_id: string;
      client_id: string | number | null;
      client_name: string | null;
      title: string;
      crm_amount: string | number | null;
      currency_id: string | null;
      stage_id: string | null;
      assigned_by_id: string | null;
      bitrix_url: string;
      state: 'unresolved' | 'active' | 'converted' | 'archived';
      linked_order_id: string | number | null;
      order_kind: string | null;
      project_id: string | number | null;
      project_code: string | null;
      full_number: string | null;
      sync_status: string;
      sync_error_code: string | null;
      detail_count: string | number;
      erp_final_amount: string | number | null;
      order_version: number | null;
      bitrix_created_at: Date | string | null;
      bitrix_updated_at: Date | string | null;
      payment_count: string | number;
      payment_amount: string | number;
      total_count: string | number;
    }>(
      `SELECT request.request_id, request.bitrix_deal_id, request.client_id,
              client.client_name, request.title, request.crm_amount,
              request.currency_id, request.stage_id, request.assigned_by_id,
              request.bitrix_url, request.state, request.linked_order_id,
              linked_order.order_kind, linked_order.project_id,
              project.code AS project_code,
              CASE WHEN project.code IS NULL THEN NULL
                   ELSE project.code || '-' || linked_order.order_name END AS full_number,
              request.sync_status, request.sync_error_code,
              (SELECT COUNT(*) FROM order_details detail
                WHERE detail.order_id=linked_order.order_id AND detail.delete_flag=false) AS detail_count,
              linked_order.final_amount AS erp_final_amount,
              linked_order.version AS order_version,
              request.bitrix_created_at, request.bitrix_updated_at,
              COUNT(payment.bitrix_payment_id)
                FILTER (WHERE payment.state <> 'deleted') AS payment_count,
              COALESCE(SUM(payment.amount)
                FILTER (WHERE payment.state <> 'deleted'), 0) AS payment_amount,
              COUNT(*) OVER() AS total_count
         FROM bitrix24_incoming_request request
         LEFT JOIN clients client ON client.client_id=request.client_id
         LEFT JOIN orders linked_order ON linked_order.order_id=request.linked_order_id
         LEFT JOIN projects project ON project.project_id=linked_order.project_id
         LEFT JOIN bitrix24_incoming_request_payment payment
           ON payment.request_id=request.request_id
         ${where}
        GROUP BY request.request_id, client.client_name, linked_order.order_kind,
                 linked_order.order_id, linked_order.project_id, linked_order.order_name,
                 linked_order.final_amount, linked_order.version, project.code
        ORDER BY request.bitrix_updated_at DESC NULLS LAST, request.request_id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const total = Number(result.rows[0]?.total_count ?? 0);
    return {
      data: result.rows.map((row) => ({
        requestId: Number(row.request_id),
        bitrixDealId: row.bitrix_deal_id,
        clientId: row.client_id === null ? null : Number(row.client_id),
        clientName: row.client_name,
        title: row.title,
        ...(input.canViewFinancials ? {
          crmAmount: row.crm_amount === null ? null : Number(row.crm_amount),
          currencyId: row.currency_id,
        } : {}),
        stageId: row.stage_id,
        assignedById: row.assigned_by_id,
        bitrixUrl: row.bitrix_url,
        state: row.state,
        linkedOrderId: row.linked_order_id === null ? null : Number(row.linked_order_id),
        linkedOrderKind: row.order_kind,
        projectId: row.project_id === null ? null : Number(row.project_id),
        projectCode: row.project_code,
        fullNumber: row.full_number,
        syncStatus: row.sync_status,
        syncErrorCode: row.sync_error_code,
        detailCount: Number(row.detail_count),
        ...(input.canViewFinancials ? {
          erpFinalAmount: row.erp_final_amount === null ? null : Number(row.erp_final_amount),
        } : {}),
        orderVersion: row.order_version,
        bitrixCreatedAt: toIso(row.bitrix_created_at),
        bitrixUpdatedAt: toIso(row.bitrix_updated_at),
        ...(input.canViewFinancials ? {
          paymentCount: Number(row.payment_count),
          paymentAmount: Number(row.payment_amount),
        } : {}),
      })),
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / input.pageSize),
      },
    };
  }

  async getIncomingRequest(
    requestId: number,
    scope: { mode: 'all' } | { mode: 'assigned'; userId: number },
    canViewFinancials: boolean,
  ): Promise<Record<string, unknown>> {
    const request = await this.db.query<{
      request_id: string | number;
      bitrix_deal_id: string;
      client_id: string | number | null;
      client_name: string | null;
      title: string;
      crm_amount: string | number | null;
      currency_id: string | null;
      stage_id: string | null;
      stage_name: string | null;
      assigned_by_id: string | null;
      assigned_by_name: string | null;
      begin_date: Date | string | null;
      close_date: Date | string | null;
      comments: string | null;
      bitrix_url: string;
      state: 'unresolved' | 'active' | 'converted' | 'archived';
      linked_order_id: string | number | null;
      order_kind: string | null;
      project_id: string | number | null;
      project_code: string | null;
      full_number: string | null;
      sync_status: string;
      sync_error_code: string | null;
      detail_count: string | number;
      erp_final_amount: string | number | null;
      order_version: number | null;
      bitrix_created_at: Date | string | null;
      bitrix_updated_at: Date | string | null;
      version: number;
    }>(
      `SELECT request.*, client.client_name, linked_order.order_kind,
              linked_order.project_id, project.code AS project_code,
              CASE WHEN project.code IS NULL THEN NULL
                   ELSE project.code || '-' || linked_order.order_name END AS full_number,
              (SELECT COUNT(*) FROM order_details detail
                WHERE detail.order_id=linked_order.order_id AND detail.delete_flag=false) AS detail_count,
              linked_order.final_amount AS erp_final_amount,
              linked_order.version AS order_version
         FROM bitrix24_incoming_request request
         LEFT JOIN clients client ON client.client_id=request.client_id
         LEFT JOIN orders linked_order ON linked_order.order_id=request.linked_order_id
         LEFT JOIN projects project ON project.project_id=linked_order.project_id
        WHERE request.request_id=$1
          AND ($2::boolean OR linked_order.manager_id=$3)`,
      [requestId, scope.mode === 'all', scope.mode === 'assigned' ? scope.userId : null],
    );
    const row = request.rows[0];
    if (!row) throw notFound('BITRIX24_REQUEST_NOT_FOUND', 'Bitrix24 incoming request not found');
    const details = await this.db.query<IncomingRequestDetailRow>(
      `SELECT detail_id, detail_number, detail_name, height, width, quantity,
              area, sheet_material_type_id, milling_type_id, edge_type_id,
              film_id, milling_cost_per_sqm, detail_cost, priority, note
         FROM order_details
        WHERE order_id=$1 AND delete_flag=false
        ORDER BY detail_number, detail_id`,
      [row.linked_order_id],
    );
    const payments = await this.db.query<{
      bitrix_payment_id: string;
      pay_system_id: number | null;
      pay_system_name: string | null;
      amount: string | number;
      currency_id: string | null;
      paid: boolean;
      payment_date: Date | string | null;
      state: string;
      erp_payment_id: string | number | null;
      mapped_type_paid_id: string | number | null;
    }>(
      `SELECT payment.bitrix_payment_id, payment.pay_system_id,
              payment.pay_system_name, payment.amount, payment.currency_id,
              payment.paid, payment.payment_date, payment.state,
              payment.erp_payment_id, mapping.type_paid_id AS mapped_type_paid_id
         FROM bitrix24_incoming_request_payment payment
         LEFT JOIN bitrix24_payment_type_mapping mapping
           ON mapping.pay_system_id=payment.pay_system_id AND mapping.active=true
        WHERE payment.request_id=$1
        ORDER BY payment.payment_date, payment.bitrix_payment_id`,
      [requestId],
    );
    return {
      requestId: Number(row.request_id),
      bitrixDealId: row.bitrix_deal_id,
      clientId: row.client_id === null ? null : Number(row.client_id),
      clientName: row.client_name,
      title: row.title,
      ...(canViewFinancials ? {
        crmAmount: row.crm_amount === null ? null : Number(row.crm_amount),
        currencyId: row.currency_id,
      } : {}),
      stageId: row.stage_id,
      stageName: row.stage_name,
      assignedById: row.assigned_by_id,
      assignedByName: row.assigned_by_name,
      beginDate: toDate(row.begin_date),
      closeDate: toDate(row.close_date),
      comments: row.comments,
      bitrixUrl: row.bitrix_url,
      state: row.state,
      linkedOrderId: row.linked_order_id === null ? null : Number(row.linked_order_id),
      linkedOrderKind: row.order_kind,
      projectId: row.project_id === null ? null : Number(row.project_id),
      projectCode: row.project_code,
      fullNumber: row.full_number,
      syncStatus: row.sync_status,
      syncErrorCode: row.sync_error_code,
      detailCount: Number(row.detail_count),
      ...(canViewFinancials ? {
        erpFinalAmount: row.erp_final_amount === null ? null : Number(row.erp_final_amount),
      } : {}),
      orderVersion: row.order_version,
      bitrixCreatedAt: toIso(row.bitrix_created_at),
      bitrixUpdatedAt: toIso(row.bitrix_updated_at),
      version: row.version,
      details: details.rows.map((detail) => mapIncomingRequestDetail(detail, canViewFinancials)),
      payments: canViewFinancials ? payments.rows.map((payment) => ({
        bitrixPaymentId: payment.bitrix_payment_id,
        paySystemId: payment.pay_system_id,
        paySystemName: payment.pay_system_name,
        amount: Number(payment.amount),
        currencyId: payment.currency_id,
        paid: payment.paid,
        paymentDate: toIso(payment.payment_date),
        state: payment.state,
        erpPaymentId:
          payment.erp_payment_id === null ? null : Number(payment.erp_payment_id),
        mappedTypePaidId:
          payment.mapped_type_paid_id === null
            ? null
            : Number(payment.mapped_type_paid_id),
      })) : [],
    };
  }

  async replaceIncomingRequestDetails(input: {
    requestId: number;
    orderVersion: number;
    details: IncomingRequestDetailInput[];
    actorUserId: number;
    actorUsername: string;
    actorRole: string;
    auditRequestId: string;
    scope: { mode: 'all' } | { mode: 'assigned'; userId: number };
    canViewFinancials: boolean;
  }): Promise<Record<string, unknown>> {
    const duplicateIds = input.details
      .flatMap((detail) => detail.id === undefined ? [] : [detail.id])
      .filter((detailId, index, all) => all.indexOf(detailId) !== index);
    if (duplicateIds.length > 0) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Detail IDs must be unique', {
        field: 'details.id',
      });
    }
    if (
      !input.canViewFinancials &&
      input.details.some(
        (detail) => detail.millingCostPerSqm !== undefined || detail.detailCost !== undefined,
      )
    ) {
      throw new ApiError(
        403,
        'PERMISSION_DENIED',
        'Financial detail fields require orders.view_financials',
      );
    }

    const discovery = await this.db.query<{
      bitrix_deal_id: string;
      linked_order_id: string | number | null;
      manager_id: string | number | null;
    }>(
      `SELECT request.bitrix_deal_id, request.linked_order_id, orders.manager_id
         FROM bitrix24_incoming_request request
         LEFT JOIN orders ON orders.order_id=request.linked_order_id
        WHERE request.request_id=$1`,
      [input.requestId],
    );
    const discovered = discovery.rows[0];
    if (
      !discovered ||
      discovered.linked_order_id === null ||
      (input.scope.mode === 'assigned' && Number(discovered.manager_id) !== input.scope.userId)
    ) {
      throw notFound('BITRIX24_REQUEST_NOT_FOUND', 'Bitrix24 incoming request not found');
    }

    return this.db.transaction(async (tx) => {
      await lockAggregate(tx, `deal:${discovered.bitrix_deal_id}`);
      const locked = await tx.query<{
        request_id: string | number;
        bitrix_deal_id: string;
        state: string;
        sync_status: string;
        linked_order_id: string | number;
        order_kind: string;
        project_id: string | number | null;
        client_id: string | number;
        manager_id: string | number | null;
        version: number;
        discount: string | number;
        surcharge: string | number;
        paid_amount: string | number;
        title: string;
        crm_amount: string | number | null;
        currency_id: string | null;
        stage_id: string | null;
        assigned_by_id: string | null;
        comments: string | null;
      }>(
        `SELECT request.request_id, request.bitrix_deal_id, request.state,
                request.sync_status, request.linked_order_id,
                orders.order_kind, orders.project_id, orders.client_id,
                orders.manager_id, orders.version, orders.discount,
                orders.surcharge, orders.paid_amount, request.title,
                request.crm_amount, request.currency_id, request.stage_id,
                request.assigned_by_id, request.comments
           FROM bitrix24_incoming_request request
           JOIN orders ON orders.order_id=request.linked_order_id
          WHERE request.request_id=$1
            AND orders.delete_flag=false
          FOR UPDATE OF request, orders`,
        [input.requestId],
      );
      const aggregate = locked.rows[0];
      if (
        !aggregate ||
        (input.scope.mode === 'assigned' && Number(aggregate.manager_id) !== input.scope.userId)
      ) {
        throw notFound('BITRIX24_REQUEST_NOT_FOUND', 'Bitrix24 incoming request not found');
      }
      if (
        aggregate.state !== 'active' ||
        aggregate.order_kind !== 'crm_request' ||
        aggregate.project_id !== null
      ) {
        throw conflict('BITRIX24_REQUEST_NOT_EDITABLE', 'Only active CRM requests can be edited');
      }
      if (aggregate.sync_status !== 'ok') {
        throw conflict('BITRIX24_REQUEST_SYNC_BLOCKED', 'Blocked CRM request cannot be edited');
      }
      if (aggregate.version !== input.orderVersion) {
        throw conflict('ORDER_VERSION_CONFLICT', 'CRM request order version changed');
      }

      const orderId = Number(aggregate.linked_order_id);
      const existing = await tx.query<{
        detail_id: string | number;
        milling_cost_per_sqm: string | number | null;
        detail_cost: string | number | null;
      }>(
        `SELECT detail_id, milling_cost_per_sqm, detail_cost
           FROM order_details
          WHERE order_id=$1 AND delete_flag=false
          ORDER BY detail_id
          FOR UPDATE`,
        [orderId],
      );
      const existingIds = new Set(existing.rows.map((row) => Number(row.detail_id)));
      const existingFinancials = new Map(existing.rows.map((row) => [
        Number(row.detail_id),
        {
          millingCostPerSqm:
            row.milling_cost_per_sqm === null ? null : Number(row.milling_cost_per_sqm),
          detailCost: row.detail_cost === null ? null : Number(row.detail_cost),
        },
      ]));
      const foreignId = input.details.find(
        (detail) => detail.id !== undefined && !existingIds.has(detail.id),
      )?.id;
      if (foreignId !== undefined) {
        throw new ApiError(422, 'DETAIL_NOT_IN_REQUEST', 'Detail does not belong to CRM request', {
          detailId: foreignId,
        });
      }

      await assertIncomingDetailReferences(tx, input.details);
      const normalized = input.details.map((detail, index) => {
        const area = calculateDetailArea(detail);
        const priorFinancials = detail.id === undefined
          ? null
          : existingFinancials.get(detail.id) ?? null;
        const millingCostPerSqm = input.canViewFinancials
          ? detail.millingCostPerSqm ?? null
          : priorFinancials?.millingCostPerSqm ?? null;
        const requestedDetailCost = input.canViewFinancials
          ? detail.detailCost ?? null
          : priorFinancials?.detailCost ?? null;
        return {
          ...detail,
          detailNumber: index + 1,
          detailName: detail.detailName?.trim() || null,
          filmId: detail.filmId ?? null,
          millingCostPerSqm,
          priority: detail.priority ?? 100,
          note: detail.note?.trim() || null,
          area,
          detailCost: calculateDetailCost({
            detailCost: requestedDetailCost,
            millingCostPerSqm,
          }, area),
        };
      });
      const retainedIds = normalized.flatMap((detail) => detail.id === undefined ? [] : [detail.id]);
      await tx.query(
        `UPDATE order_details
            SET delete_flag=true, edited_by=$2
          WHERE order_id=$1 AND delete_flag=false
            AND NOT (detail_id = ANY($3::bigint[]))`,
        [orderId, input.actorUserId, retainedIds],
      );

      for (const detail of normalized) {
        if (detail.id !== undefined) {
          await tx.query(
            `UPDATE order_details
                SET detail_number=$3, detail_name=$4, height=$5, width=$6,
                    quantity=$7, area=$8, material_id=NULL,
                    sheet_material_type_id=$9, milling_type_id=$10,
                    edge_type_id=$11, film_id=$12, milling_cost_per_sqm=$13,
                    detail_cost=$14, priority=$15, production_status_id=NULL,
                    joint_order_id=NULL, note=$16, edited_by=$17
              WHERE detail_id=$1 AND order_id=$2 AND delete_flag=false`,
            [
              detail.id, orderId, detail.detailNumber, detail.detailName,
              detail.height, detail.width, detail.quantity, detail.area,
              detail.sheetMaterialTypeId, detail.millingTypeId, detail.edgeTypeId,
              detail.filmId, detail.millingCostPerSqm, detail.detailCost,
              detail.priority, detail.note, input.actorUserId,
            ],
          );
        } else {
          await tx.query(
            `INSERT INTO order_details (
               order_id, detail_number, detail_name, height, width, quantity,
               area, material_id, sheet_material_type_id, milling_type_id,
               edge_type_id, film_id, milling_cost_per_sqm, detail_cost,
               priority, production_status_id, joint_order_id, note,
               created_by, edited_by
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13,$14,
               NULL,NULL,$15,$16,$16
             )`,
            [
              orderId, detail.detailNumber, detail.detailName, detail.height,
              detail.width, detail.quantity, detail.area,
              detail.sheetMaterialTypeId, detail.millingTypeId,
              detail.edgeTypeId, detail.filmId, detail.millingCostPerSqm,
              detail.detailCost, detail.priority, detail.note, input.actorUserId,
            ],
          );
        }
      }

      const totals = await tx.query<{
        detail_count: string | number;
        parts_count: string | number;
        total_area: string | number;
        total_amount: string | number;
      }>(
        `SELECT COUNT(*) AS detail_count,
                COALESCE(SUM(quantity),0) AS parts_count,
                COALESCE(SUM(area),0) AS total_area,
                COALESCE(SUM(detail_cost),0) AS total_amount
           FROM order_details
          WHERE order_id=$1 AND delete_flag=false`,
        [orderId],
      );
      const totalAmount = roundMoney(Number(totals.rows[0]?.total_amount ?? 0));
      const finalAmount = roundMoney(
        totalAmount - Number(aggregate.discount) + Number(aggregate.surcharge),
      );
      if (finalAmount < 0) {
        throw new ApiError(422, 'ORDER_FINAL_AMOUNT_NEGATIVE', 'ERP final amount cannot be negative');
      }
      const updated = await tx.query<{ version: number }>(
        `UPDATE orders
            SET parts_count=$2, total_area=$3, total_amount=$4,
                final_amount=$5, edited_by=$6, version=version+1
          WHERE order_id=$1
          RETURNING version`,
        [
          orderId,
          Number(totals.rows[0]?.parts_count ?? 0),
          Number(totals.rows[0]?.total_area ?? 0),
          totalAmount,
          finalAmount,
          input.actorUserId,
        ],
      );
      const savedDetails = await tx.query<IncomingRequestDetailRow>(
        `SELECT detail_id, detail_number, detail_name, height, width, quantity,
                area, sheet_material_type_id, milling_type_id, edge_type_id,
                film_id, milling_cost_per_sqm, detail_cost, priority, note
           FROM order_details
          WHERE order_id=$1 AND delete_flag=false
          ORDER BY detail_number, detail_id`,
        [orderId],
      );
      const lifecycleFields = incomingRequestAuditFields(aggregate);
      await recordCrmRequestUpdated(tx, this.audit, {
        orderId,
        clientId: Number(aggregate.client_id),
        requestId: Number(aggregate.request_id),
        bitrixDealId: aggregate.bitrix_deal_id,
        actorType: 'erp_user',
        actorUserId: input.actorUserId,
        sourceSystem: 'erp',
        correlationId: input.auditRequestId,
        mutationVersion: String(updated.rows[0].version),
        before: lifecycleFields,
        after: lifecycleFields,
      });
      return {
        orderId,
        orderVersion: updated.rows[0].version,
        detailCount: Number(totals.rows[0]?.detail_count ?? 0),
        ...(input.canViewFinancials ? { erpFinalAmount: finalAmount } : {}),
        details: savedDetails.rows.map((detail) =>
          mapIncomingRequestDetail(detail, input.canViewFinancials)),
      };
    });
  }

  async convertCrmRequestToProduction(input: {
    orderId: number;
    expectedVersion: number;
    orderName: string;
    projectId: number | null;
    createProject: boolean;
    idempotencyKey: string;
    actorUserId: number;
    actorUsername: string;
    actorRole: string;
    requestId: string;
    scope: { mode: 'all' } | { mode: 'assigned'; userId: number };
    initialOrderStatusCode: string;
    initialProductionStatusCode: string;
  }): Promise<Record<string, unknown>> {
    const normalizedName = input.orderName.replace(/\s+/gu, ' ').trim();
    if (!normalizedName || normalizedName.length > 200) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Production order name is invalid');
    }
    const requestHash = createHash('sha256').update(JSON.stringify({
      orderId: input.orderId,
      expectedVersion: input.expectedVersion,
      orderName: normalizedName.toLocaleLowerCase('ru'),
      projectId: input.projectId,
      createProject: input.createProject,
    })).digest('hex');
    const discovery = await this.db.query<{
      bitrix_deal_id: string;
      client_id: string | number;
      manager_id: string | number | null;
    }>(
      `SELECT request.bitrix_deal_id, orders.client_id, orders.manager_id
         FROM orders
         JOIN bitrix24_incoming_request request
           ON request.linked_order_id=orders.order_id
        WHERE orders.order_id=$1`,
      [input.orderId],
    );
    const discovered = discovery.rows[0];
    if (
      !discovered ||
      (input.scope.mode === 'assigned' && Number(discovered.manager_id) !== input.scope.userId)
    ) {
      throw notFound('ORDER_NOT_FOUND', 'Order not found');
    }

    return this.db.transaction(async (tx) => {
      await tx.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('order_name:' || normalize_order_name($1), 0)
         )`,
        [normalizedName],
      );
      await lockAggregate(tx, `deal:${discovered.bitrix_deal_id}`);

      const existingCommand = await tx.query<{
        request_hash: string;
        status: string;
        response_json: Record<string, unknown> | null;
      }>(
        `INSERT INTO order_kind_conversion_command (
           idempotency_key, order_id, request_hash, actor_user_id
         ) VALUES ($1,$2,$3,$4)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING request_hash, status, response_json`,
        [input.idempotencyKey, input.orderId, requestHash, input.actorUserId],
      );
      let commandRow = existingCommand.rows[0];
      if (!commandRow) {
        const prior = await tx.query<{
          request_hash: string;
          status: string;
          response_json: Record<string, unknown> | null;
        }>(
          `SELECT request_hash, status, response_json
             FROM order_kind_conversion_command
            WHERE idempotency_key=$1
            FOR UPDATE`,
          [input.idempotencyKey],
        );
        commandRow = prior.rows[0];
        if (!commandRow || commandRow.request_hash !== requestHash) {
          throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another conversion');
        }
        if (commandRow.status === 'completed' && commandRow.response_json) {
          return commandRow.response_json;
        }
      }

      if (input.projectId !== null) {
        await tx.query('SELECT project_id FROM projects WHERE project_id=$1 FOR UPDATE', [input.projectId]);
      }
      const order = await tx.query<{
        client_id: string | number;
        order_kind: string;
        source_system: string;
        project_id: string | number | null;
        version: number;
        delete_flag: boolean;
        discount: string | number;
        surcharge: string | number;
      }>(
        `SELECT client_id, order_kind, source_system, project_id, version,
                delete_flag, discount, surcharge
           FROM orders WHERE order_id=$1 FOR UPDATE`,
        [input.orderId],
      );
      const orderRow = order.rows[0];
      const request = await tx.query<{
        request_id: string | number;
        state: string;
        sync_status: string;
        bitrix_deal_id: string;
      }>(
        `SELECT request_id, state, sync_status, bitrix_deal_id
           FROM bitrix24_incoming_request
          WHERE linked_order_id=$1
          FOR UPDATE`,
        [input.orderId],
      );
      const requestRow = request.rows[0];
      if (
        !orderRow || !requestRow || orderRow.delete_flag ||
        orderRow.order_kind !== 'crm_request' || orderRow.source_system !== 'bitrix24' ||
        requestRow.state !== 'active'
      ) {
        throw conflict('ORDER_NOT_CONVERTIBLE', 'CRM request is no longer convertible');
      }
      if (requestRow.sync_status !== 'ok') {
        throw conflict('BITRIX24_REQUEST_BLOCKED', 'Resolve the Bitrix24 synchronization conflict first');
      }
      if (orderRow.version !== input.expectedVersion) {
        throw conflict('VERSION_CONFLICT', 'Order version conflict');
      }
      const details = await tx.query<{ detail_id: string | number }>(
        `SELECT detail_id FROM order_details
          WHERE order_id=$1 AND delete_flag=false
          ORDER BY detail_id FOR UPDATE`,
        [input.orderId],
      );
      if (details.rows.length === 0) {
        throw new ApiError(422, 'ORDER_DETAILS_REQUIRED', 'Production order requires at least one detail');
      }
      const statuses = await tx.query<{
        order_status_id: string | number;
        production_status_id: string | number;
      }>(
        `SELECT order_status.order_status_id, production_status.production_status_id
           FROM order_statuses order_status
           CROSS JOIN production_statuses production_status
          WHERE order_status.order_status_code=$1 AND order_status.is_active=true
            AND production_status.production_status_code=$2
            AND production_status.is_active=true`,
        [input.initialOrderStatusCode, input.initialProductionStatusCode],
      );
      const status = statuses.rows[0];
      if (!status) {
        throw new ApiError(503, 'ORDER_INITIAL_STATUS_INVALID', 'Configured initial order statuses are invalid');
      }
      const duplicate = await tx.query(
        `SELECT 1
           FROM orders
          WHERE delete_flag=false AND order_kind='production_order'
            AND normalize_order_name(order_name)=normalize_order_name($1)
            AND order_id<>$2
         UNION ALL
         SELECT 1
           FROM order_legacy_duplicate_name_registry registry
          WHERE registry.normalized_name=normalize_order_name($1)
          LIMIT 1`,
        [normalizedName, input.orderId],
      );
      if (duplicate.rowCount) {
        throw conflict('ORDER_NAME_CONFLICT', 'Production order name already exists');
      }

      let projectId = input.projectId;
      let projectCode: string;
      if (input.createProject) {
        const project = await tx.query<{ project_id: string | number; code: string }>(
          `WITH next_project AS (
             SELECT nextval(pg_get_serial_sequence('public.projects','project_id')) AS project_id
           )
           INSERT INTO projects (project_id, code, name, client_id, created_by)
           SELECT project_id, 'МП-' || project_id, LEFT($1,300), $2, $3
             FROM next_project
           RETURNING project_id, code`,
          [normalizedName, orderRow.client_id, input.actorUserId],
        );
        projectId = Number(project.rows[0].project_id);
        projectCode = project.rows[0].code;
        await this.audit.record(tx, {
          event: 'project.created',
          entityType: 'project',
          entityId: projectId,
          actorUserId: input.actorUserId,
          actorUsername: input.actorUsername,
          actorRole: input.actorRole,
          requestId: input.requestId,
          source: 'backend-bitrix24',
          relatedClientId: Number(orderRow.client_id),
          before: null,
          after: {
            projectId,
            code: projectCode,
            name: normalizedName,
            clientId: Number(orderRow.client_id),
          },
          metadata: { origin: 'crm_request_conversion' },
          relatedEntities: [
            { entityType: 'project', entityId: projectId },
            { entityType: 'client', entityId: Number(orderRow.client_id) },
          ],
        });
        await enqueueDomainEvent(tx, {
          eventType: 'project.created',
          aggregateType: 'project',
          aggregateId: String(projectId),
          idempotencyKey: `project.created:conversion:${input.idempotencyKey}`,
          payload: {
            eventType: 'project.created',
            projectId,
            code: projectCode,
            clientId: Number(orderRow.client_id),
            actorUserId: input.actorUserId,
            requestId: input.requestId,
          },
        });
      } else {
        const project = await tx.query<{ code: string }>(
          `SELECT code FROM projects
            WHERE project_id=$1 AND client_id=$2 AND delete_flag=false`,
          [projectId, orderRow.client_id],
        );
        if (!project.rows[0]) {
          throw conflict('PROJECT_CLIENT_MISMATCH', 'Project is missing, archived, or belongs to another client');
        }
        projectCode = project.rows[0].code;
      }

      await tx.query(
        `UPDATE order_details
            SET production_status_id=$2
          WHERE order_id=$1 AND delete_flag=false`,
        [input.orderId, status.production_status_id],
      );
      await tx.query(
        `INSERT INTO production_status_events (
           detail_id, production_status_id, event_by, note, payload
         )
         SELECT detail_id, $2, $3, 'CRM request conversion',
                jsonb_build_object('origin','crm_request_conversion')
           FROM order_details
          WHERE order_id=$1 AND delete_flag=false
         ON CONFLICT DO NOTHING`,
        [input.orderId, status.production_status_id, input.actorUserId],
      );
      const totals = await tx.query<{
        parts_count: string | number;
        total_area: string | number;
        total_amount: string | number;
      }>(
        `SELECT COALESCE(SUM(quantity),0) AS parts_count,
                COALESCE(SUM(area),0) AS total_area,
                COALESCE(SUM(detail_cost),0) AS total_amount
           FROM order_details
          WHERE order_id=$1 AND delete_flag=false`,
        [input.orderId],
      );
      const totalAmount = roundMoney(Number(totals.rows[0]?.total_amount ?? 0));
      const finalAmount = roundMoney(
        totalAmount - Number(orderRow.discount) + Number(orderRow.surcharge),
      );
      if (finalAmount < 0) {
        throw new ApiError(
          422,
          'ORDER_FINAL_AMOUNT_NEGATIVE',
          'ERP final amount cannot be negative',
        );
      }
      await tx.query(
        `UPDATE orders
            SET order_name=$2, project_id=$3, order_kind='production_order',
                order_status_id=$4, production_status_id=$5,
                production_status_from_details_enabled=true,
                legacy_zero_detail_exempt=false, edited_by=$6,
                parts_count=$7, total_area=$8, total_amount=$9,
                final_amount=$10, version=version+1
          WHERE order_id=$1`,
        [
          input.orderId,
          normalizedName,
          projectId,
          status.order_status_id,
          status.production_status_id,
          input.actorUserId,
          Number(totals.rows[0]?.parts_count ?? 0),
          Number(totals.rows[0]?.total_area ?? 0),
          totalAmount,
          finalAmount,
        ],
      );
      await tx.query(
        `INSERT INTO production_status_events (
           order_id, production_status_id, event_by, note, payload
         ) VALUES ($1,$2,$3,'CRM request conversion',
                   jsonb_build_object('origin','crm_request_conversion'))
         ON CONFLICT DO NOTHING`,
        [input.orderId, status.production_status_id, input.actorUserId],
      );
      await tx.query(
        `UPDATE bitrix24_incoming_request
            SET state='converted', sync_version=sync_version+1,
                version=version+1, updated_at=now()
          WHERE request_id=$1`,
        [requestRow.request_id],
      );
      const response = {
        orderId: input.orderId,
        orderKind: 'production_order',
        sourceSystem: 'bitrix24',
        projectId,
        projectCode,
        fullNumber: `${projectCode}-${normalizedName}`,
        version: orderRow.version + 1,
      };
      await this.audit.record(tx, {
        event: 'orders.converted_to_production',
        entityType: 'order',
        entityId: input.orderId,
        actorUserId: input.actorUserId,
        actorUsername: input.actorUsername,
        actorRole: input.actorRole,
        requestId: input.requestId,
        source: 'backend-bitrix24',
        relatedOrderId: input.orderId,
        relatedClientId: Number(orderRow.client_id),
        before: { orderKind: 'crm_request', projectId: null, requestState: 'active' },
        after: {
          orderKind: 'production_order', projectId, orderName: normalizedName,
          requestState: 'converted', orderStatusCode: input.initialOrderStatusCode,
          productionStatusCode: input.initialProductionStatusCode,
        },
        metadata: { bitrixDealId: requestRow.bitrix_deal_id },
      });
      await enqueueDomainEvent(tx, {
        eventType: 'orders.converted_to_production',
        aggregateType: 'order',
        aggregateId: String(input.orderId),
        idempotencyKey: `conversion:${input.idempotencyKey}`,
        payload: {
          eventVersion: 1,
          eventName: 'orders.converted_to_production',
          orderId: input.orderId,
          clientId: Number(orderRow.client_id),
          projectId,
          incomingRequestId: Number(requestRow.request_id),
          bitrixDealId: requestRow.bitrix_deal_id,
          actorType: 'erp_user',
          actorUserId: input.actorUserId,
          sourceSystem: 'bitrix24',
          requestId: input.requestId,
        },
      });
      await enqueueDomainEvent(tx, {
        eventType: 'orders.production_initialized',
        aggregateType: 'order',
        aggregateId: String(input.orderId),
        idempotencyKey: `production-init:${input.orderId}:${input.idempotencyKey}`,
        payload: {
          orderId: input.orderId,
          actorUserId: input.actorUserId,
          actorUsername: input.actorUsername,
          actorRole: input.actorRole,
          requestId: input.requestId,
        },
      });
      await tx.query(
        `UPDATE order_kind_conversion_command
            SET status='completed', response_json=$2::jsonb,
                completed_at=now(), updated_at=now()
          WHERE idempotency_key=$1`,
        [input.idempotencyKey, JSON.stringify(response)],
      );
      return response;
    });
  }

  async materializeRequestPayments(input: {
    requestId: number;
    actorUserId: string;
    auditRequestId: string;
    scope: { mode: 'all' } | { mode: 'assigned'; userId: number };
  }): Promise<Record<string, unknown>> {
    const discovery = await this.db.query<{
      bitrix_deal_id: string;
      linked_order_id: string | number | null;
      state: string;
    }>(
      `SELECT request.bitrix_deal_id, request.linked_order_id, request.state
         FROM bitrix24_incoming_request request
         LEFT JOIN orders ON orders.order_id=request.linked_order_id
        WHERE request.request_id=$1
          AND ($2::boolean OR orders.manager_id=$3)`,
      [
        input.requestId,
        input.scope.mode === 'all',
        input.scope.mode === 'assigned' ? input.scope.userId : null,
      ],
    );
    const discovered = discovery.rows[0];
    if (!discovered) {
      throw notFound('BITRIX24_REQUEST_NOT_FOUND', 'Bitrix24 incoming request not found');
    }
    if (discovered.state !== 'converted' || discovered.linked_order_id === null) {
      throw conflict(
        'BITRIX24_REQUEST_NOT_CONVERTED',
        'Convert the CRM request to a production order before materializing payments',
      );
    }
    const orderId = Number(discovered.linked_order_id);
    await this.db.transaction(async (tx) => {
      await lockAggregate(tx, `deal:${discovered.bitrix_deal_id}`);
      await setReverseOrigin(tx);
      const productionOrder = await tx.query(
        `SELECT 1
           FROM orders
          WHERE order_id=$1 AND order_kind='production_order'
            AND delete_flag=false
            AND EXISTS (
              SELECT 1 FROM order_details
               WHERE order_details.order_id=orders.order_id
                 AND order_details.delete_flag=false
            )
          FOR UPDATE`,
        [orderId],
      );
      if (productionOrder.rowCount !== 1) {
        throw conflict(
          'ORDER_NOT_READY_FOR_PAYMENTS',
          'Production order with an active detail is required for payments',
        );
      }
      const request = await tx.query<{
        linked_order_id: string | number | null;
        state: string;
      }>(
        `SELECT request.linked_order_id, request.state
           FROM bitrix24_incoming_request request
           JOIN orders ON orders.order_id=request.linked_order_id
          WHERE request.request_id=$1
            AND request.bitrix_deal_id=$2
            AND request.linked_order_id=$3
            AND ($4::boolean OR orders.manager_id=$5)
          FOR UPDATE OF request`,
        [
          input.requestId,
          discovered.bitrix_deal_id,
          orderId,
          input.scope.mode === 'all',
          input.scope.mode === 'assigned' ? input.scope.userId : null,
        ],
      );
      const row = request.rows[0];
      if (!row) {
        throw notFound('BITRIX24_REQUEST_NOT_FOUND', 'Bitrix24 incoming request not found');
      }
      if (row.state !== 'converted') {
        throw conflict(
          'BITRIX24_REQUEST_NOT_CONVERTED',
          'Convert the CRM request to a production order before materializing payments',
        );
      }
      const deleted = await tx.query(
        `UPDATE payments erp
            SET delete_flag=true, updated_at=now()
           FROM bitrix24_incoming_request_payment remote
          WHERE remote.request_id=$1
            AND (remote.state='deleted' OR remote.paid=false)
            AND remote.erp_payment_id=erp.payment_id
            AND erp.delete_flag=false`,
        [input.requestId],
      );
      const count = await materializeActivePayments(
        tx,
        input.requestId,
        orderId,
        true,
      );
      const deletedCount = deleted.rowCount ?? 0;
      if (count > 0 || deletedCount > 0) {
        await recalculatePaymentState(tx, orderId);
        await this.audit.record(tx, {
          event: 'bitrix24_reverse.payments_materialize',
          entityType: 'bitrix24_incoming_request',
          entityId: input.requestId,
          actorUserId: input.actorUserId,
          requestId: input.auditRequestId,
          source: 'backend-bitrix24',
          relatedOrderId: orderId,
          after: {
            changedPaymentCount: count,
            deletedPaymentCount: deletedCount,
          },
        });
      }
    });
    return this.getIncomingRequest(input.requestId, input.scope, true);
  }

  async materializeMappedOrderPayments(input: {
    orderId: number;
    actorUserId: string;
    auditRequestId: string;
    scope: { mode: 'all' } | { mode: 'assigned'; userId: number };
  }): Promise<Record<string, unknown>> {
    const discovery = await this.db.query<{
      bitrix_deal_id: string;
    }>(
      `SELECT mapping.bitrix_id AS bitrix_deal_id
         FROM crm_sync_mapping mapping
         JOIN orders ON orders.order_id=mapping.erp_id::bigint
        WHERE mapping.entity_type='order'
          AND mapping.erp_id=$1
          AND mapping.bitrix_object='deal'
          AND mapping.bitrix_id IS NOT NULL
          AND mapping.status='active'
          AND orders.order_kind='production_order'
          AND orders.delete_flag=false
          AND ($2::boolean OR orders.manager_id=$3)`,
      [
        String(input.orderId),
        input.scope.mode === 'all',
        input.scope.mode === 'assigned' ? input.scope.userId : null,
      ],
    );
    const discovered = discovery.rows[0];
    if (!discovered) {
      throw notFound('BITRIX24_MAPPED_ORDER_NOT_FOUND', 'Mapped production order not found');
    }

    let changedPaymentCount = 0;
    let deletedPaymentCount = 0;
    await this.db.transaction(async (tx) => {
      await lockAggregate(tx, `deal:${discovered.bitrix_deal_id}`);
      await setReverseOrigin(tx);
      const lockedOrder = await tx.query(
        `SELECT 1
           FROM orders
          WHERE order_id=$1
            AND order_kind='production_order'
            AND delete_flag=false
            AND ($2::boolean OR manager_id=$3)
            AND EXISTS (
              SELECT 1 FROM order_details
               WHERE order_details.order_id=orders.order_id
                 AND order_details.delete_flag=false
            )
          FOR UPDATE`,
        [
          input.orderId,
          input.scope.mode === 'all',
          input.scope.mode === 'assigned' ? input.scope.userId : null,
        ],
      );
      if (lockedOrder.rowCount !== 1) {
        throw conflict(
          'ORDER_NOT_READY_FOR_PAYMENTS',
          'Mapped production order with an active detail is required for payments',
        );
      }
      const mapping = await tx.query(
        `SELECT 1
           FROM crm_sync_mapping
          WHERE entity_type='order' AND erp_id=$1
            AND bitrix_object='deal' AND bitrix_id=$2 AND status='active'
          FOR UPDATE`,
        [String(input.orderId), discovered.bitrix_deal_id],
      );
      if (mapping.rowCount !== 1) {
        throw conflict('BITRIX24_DEAL_MAPPING_CHANGED', 'Bitrix24 Deal mapping changed');
      }
      const deleted = await tx.query(
        `UPDATE payments erp
            SET delete_flag=true, updated_at=now()
           FROM bitrix24_incoming_request_payment remote
          WHERE remote.erp_order_id=$1
            AND (remote.state='deleted' OR remote.paid=false)
            AND remote.erp_payment_id=erp.payment_id
            AND erp.delete_flag=false`,
        [input.orderId],
      );
      changedPaymentCount = await materializeMappedOrderPaymentRows(tx, input.orderId);
      deletedPaymentCount = deleted.rowCount ?? 0;
      if (changedPaymentCount > 0 || deletedPaymentCount > 0) {
        await recalculatePaymentState(tx, input.orderId);
        await this.audit.record(tx, {
          event: 'bitrix24_reverse.mapped_order_payments_materialize',
          entityType: 'order',
          entityId: input.orderId,
          actorUserId: input.actorUserId,
          requestId: input.auditRequestId,
          source: 'backend-bitrix24',
          relatedOrderId: input.orderId,
          after: { changedPaymentCount, deletedPaymentCount },
        });
      }
    });
    return {
      orderId: input.orderId,
      changedPaymentCount,
      deletedPaymentCount,
    };
  }

  async listUserMappings(): Promise<Array<Record<string, unknown>>> {
    const result = await this.db.query<{
      mapping_id: string | number;
      bitrix_user_id: string;
      erp_user_id: string | number;
      username: string;
      full_name: string | null;
      is_active: boolean;
      updated_at: Date | string;
    }>(
      `SELECT mapping.mapping_id, mapping.bitrix_user_id, mapping.erp_user_id,
              target.username, target.full_name, mapping.is_active,
              mapping.updated_at
         FROM bitrix24_user_mapping mapping
         JOIN users target ON target.user_id=mapping.erp_user_id
        ORDER BY mapping.is_active DESC, mapping.bitrix_user_id::bigint,
                 mapping.mapping_id DESC`,
    );
    return result.rows.map((row) => ({
      mappingId: Number(row.mapping_id),
      bitrixUserId: row.bitrix_user_id,
      erpUserId: Number(row.erp_user_id),
      erpUsername: row.username,
      erpFullName: row.full_name,
      active: row.is_active,
      updatedAt: toIso(row.updated_at),
    }));
  }

  async listUserMappingTargets(): Promise<Array<Record<string, unknown>>> {
    const result = await this.db.query<{
      user_id: string | number;
      username: string;
      full_name: string | null;
      role_code: string;
    }>(
      `SELECT target.user_id, target.username, target.full_name, role.role_code
         FROM users target
         JOIN roles role ON role.role_id=target.role_id
        WHERE target.is_active=true AND target.is_service_account=false
        ORDER BY COALESCE(target.full_name, target.username), target.user_id`,
    );
    return result.rows.map((row) => ({
      userId: Number(row.user_id),
      username: row.username,
      fullName: row.full_name,
      role: row.role_code,
    }));
  }

  async upsertUserMapping(input: {
    bitrixUserId: string;
    erpUserId: number;
    active: boolean;
    actorUserId: string;
    actorUsername: string;
    actorRole: string;
    auditRequestId: string;
  }): Promise<Record<string, unknown>> {
    await this.db.transaction(async (tx) => {
      await lockAggregate(tx, `responsible-map:${input.bitrixUserId}`);
      const target = await tx.query(
        `SELECT 1 FROM users
          WHERE user_id=$1 AND is_active=true AND is_service_account=false`,
        [input.erpUserId],
      );
      if (target.rowCount !== 1) {
        throw notFound(
          'BITRIX24_MAPPING_USER_NOT_FOUND',
          'ERP mapping target must be an active non-service user',
        );
      }
      const current = await tx.query<{
        mapping_id: string | number;
        erp_user_id: string | number;
        is_active: boolean;
      }>(
        `SELECT mapping_id, erp_user_id, is_active
           FROM bitrix24_user_mapping
          WHERE bitrix_user_id=$1
          ORDER BY is_active DESC, mapping_id DESC
          LIMIT 1
          FOR UPDATE`,
        [input.bitrixUserId],
      );
      const before = current.rows[0];
      if (
        before &&
        Number(before.erp_user_id) === input.erpUserId &&
        before.is_active === input.active
      ) {
        return;
      }
      const saved = before
        ? await tx.query<{ mapping_id: string | number }>(
            `UPDATE bitrix24_user_mapping
                SET erp_user_id=$2, is_active=$3, updated_by=$4, updated_at=now()
              WHERE mapping_id=$1
              RETURNING mapping_id`,
            [before.mapping_id, input.erpUserId, input.active, input.actorUserId],
          )
        : await tx.query<{ mapping_id: string | number }>(
            `INSERT INTO bitrix24_user_mapping (
               bitrix_user_id, erp_user_id, is_active, created_by, updated_by
             ) VALUES ($1,$2,$3,$4,$4)
             RETURNING mapping_id`,
            [input.bitrixUserId, input.erpUserId, input.active, input.actorUserId],
          );
      await this.audit.record(tx, {
        event: 'bitrix24.user_mapping_upserted',
        entityType: 'bitrix24_user_mapping',
        entityId: Number(saved.rows[0].mapping_id),
        actorUserId: input.actorUserId,
        actorUsername: input.actorUsername,
        actorRole: input.actorRole,
        requestId: input.auditRequestId,
        source: 'backend-bitrix24',
        before: before
          ? { erpUserId: Number(before.erp_user_id), active: before.is_active }
          : null,
        after: {
          bitrixUserId: input.bitrixUserId,
          erpUserId: input.erpUserId,
          active: input.active,
        },
      });
    });
    const mappings = await this.listUserMappings();
    return mappings.find((mapping) =>
      mapping.bitrixUserId === input.bitrixUserId && mapping.active === input.active)
      ?? mappings.find((mapping) => mapping.bitrixUserId === input.bitrixUserId)
      ?? {};
  }

  async listPaymentTypeMappings(): Promise<Array<Record<string, unknown>>> {
    const result = await this.db.query<{
      pay_system_id: number;
      pay_system_name: string | null;
      type_paid_id: number | null;
      type_paid_name: string | null;
      active: boolean;
    }>(
      `WITH systems AS (
         SELECT payment.pay_system_id,
                MAX(payment.pay_system_name) AS pay_system_name
           FROM bitrix24_incoming_request_payment payment
          WHERE payment.pay_system_id IS NOT NULL
          GROUP BY payment.pay_system_id
         UNION
         SELECT mapping.pay_system_id, NULL::text
           FROM bitrix24_payment_type_mapping mapping
       )
       SELECT systems.pay_system_id,
              MAX(systems.pay_system_name) AS pay_system_name,
              mapping.type_paid_id,
              type.type_paid AS type_paid_name,
              COALESCE(mapping.active, false) AS active
         FROM systems
         LEFT JOIN bitrix24_payment_type_mapping mapping
           ON mapping.pay_system_id=systems.pay_system_id
         LEFT JOIN payment_types type ON type.type_paid_id=mapping.type_paid_id
        GROUP BY systems.pay_system_id, mapping.type_paid_id,
                 type.type_paid, mapping.active
        ORDER BY systems.pay_system_id`,
    );
    return result.rows.map((row) => ({
      paySystemId: row.pay_system_id,
      paySystemName: row.pay_system_name,
      typePaidId: row.type_paid_id,
      typePaidName: row.type_paid_name,
      active: row.active,
    }));
  }

  async upsertPaymentTypeMapping(input: {
    paySystemId: number;
    typePaidId: number;
    active: boolean;
    actorUserId: string;
    auditRequestId: string;
  }): Promise<Record<string, unknown>> {
    await this.db.transaction(async (tx) => {
      const exists = await tx.query(
        'SELECT 1 FROM payment_types WHERE type_paid_id=$1',
        [input.typePaidId],
      );
      if (exists.rowCount !== 1) {
        throw notFound('PAYMENT_TYPE_NOT_FOUND', 'ERP payment type not found');
      }
      await tx.query(
        `INSERT INTO bitrix24_payment_type_mapping (
           pay_system_id, type_paid_id, active, created_by, updated_by
         )
         VALUES ($1,$2,$3,$4,$4)
         ON CONFLICT (pay_system_id) DO UPDATE SET
           type_paid_id=EXCLUDED.type_paid_id, active=EXCLUDED.active,
           updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [input.paySystemId, input.typePaidId, input.active, input.actorUserId],
      );
      await this.audit.record(tx, {
        event: 'bitrix24_reverse.payment_type_mapping_upsert',
        entityType: 'bitrix24_payment_type_mapping',
        entityId: input.paySystemId,
        actorUserId: input.actorUserId,
        requestId: input.auditRequestId,
        source: 'backend-bitrix24',
        after: {
          typePaidId: input.typePaidId,
          active: input.active,
        },
      });
    });
    const mappings = await this.listPaymentTypeMappings();
    return mappings.find((mapping) => mapping.paySystemId === input.paySystemId) ?? {};
  }

  async getSyncHealth(): Promise<Record<string, unknown>> {
    const result = await this.db.query<{
      pending: string | number;
      processing: string | number;
      failed: string | number;
      dead: string | number;
      last_processed_at: Date | string | null;
      last_reconcile_at: Date | string | null;
      installation_status: string | null;
      token_expires_at: Date | string | null;
      last_installation_error: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE event.status='pending') AS pending,
         COUNT(*) FILTER (WHERE event.status='processing') AS processing,
         COUNT(*) FILTER (WHERE event.status='failed') AS failed,
         COUNT(*) FILTER (WHERE event.status='dead') AS dead,
         MAX(event.processed_at) AS last_processed_at,
         (SELECT last_cycle_at FROM bitrix24_reconcile_cursor
           WHERE scope='deal_payments') AS last_reconcile_at,
         (SELECT status FROM bitrix24_app_installation ORDER BY updated_at DESC LIMIT 1)
           AS installation_status,
         (SELECT access_token_expires_at FROM bitrix24_app_installation
           ORDER BY updated_at DESC LIMIT 1) AS token_expires_at,
         (SELECT last_error FROM bitrix24_app_installation
           ORDER BY updated_at DESC LIMIT 1) AS last_installation_error
       FROM bitrix24_inbound_event event`,
    );
    const row = result.rows[0];
    return {
      queue: {
        pending: Number(row?.pending ?? 0),
        processing: Number(row?.processing ?? 0),
        failed: Number(row?.failed ?? 0),
        dead: Number(row?.dead ?? 0),
      },
      lastProcessedAt: toIso(row?.last_processed_at ?? null),
      lastReconcileAt: toIso(row?.last_reconcile_at ?? null),
      installationStatus: row?.installation_status ?? null,
      tokenExpiresAt: toIso(row?.token_expires_at ?? null),
      lastError: row?.last_installation_error ?? null,
    };
  }

  async retryFailedEvents(input: {
    actorUserId: string;
    auditRequestId: string;
  }): Promise<number> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query(
        `UPDATE bitrix24_inbound_event
            SET status='pending', attempts=0, next_attempt_at=now(),
                last_error=NULL, locked_at=NULL, locked_by=NULL, lock_token=NULL
          WHERE status IN ('failed','dead')`,
      );
      const blocked = await tx.query(
        `WITH installation AS (
           SELECT member_id
             FROM bitrix24_app_installation
            WHERE status <> 'revoked'
            ORDER BY updated_at DESC
            LIMIT 1
         )
         INSERT INTO bitrix24_inbound_event (
           member_id, event_name, object_type, bitrix_id, event_ts,
           payload_json, fingerprint
         )
         SELECT installation.member_id, 'BITRIX24_ADMIN_RETRY_DEAL', 'deal',
                request.bitrix_deal_id, now(),
                jsonb_build_object('source','admin-retry','requestId',request.request_id),
                'admin-retry:' || request.request_id || ':' || gen_random_uuid()::text
           FROM bitrix24_incoming_request request
           CROSS JOIN installation
          WHERE request.sync_status='blocked'`,
      );
      const retried = (result.rowCount ?? 0) + (blocked.rowCount ?? 0);
      await this.audit.record(tx, {
        event: 'bitrix24_reverse.retry_failed',
        entityType: 'bitrix24_inbound_event',
        entityId: 'failed',
        actorUserId: input.actorUserId,
        requestId: input.auditRequestId,
        source: 'backend-bitrix24',
        after: {
          retried,
          failedEventsRetried: result.rowCount ?? 0,
          blockedRequestsEnqueued: blocked.rowCount ?? 0,
        },
      });
      return retried;
    });
  }

  private async readMapping(
    client: DatabaseClient,
    where: string,
    params: readonly unknown[],
  ): Promise<ReverseMappingRow | null> {
    const result = await client.query<{
      entity_type: ReverseMappingRow['entityType'];
      erp_id: string;
      bitrix_object: string;
      bitrix_id: string | null;
      parent_erp_id: string | null;
      status: string;
      source_system: ReverseMappingRow['sourceSystem'];
      last_bitrix_hash: string | null;
      last_bitrix_updated_at: Date | string | null;
    }>(
      `SELECT entity_type, erp_id, bitrix_object, bitrix_id, parent_erp_id,
              status, source_system, last_bitrix_hash, last_bitrix_updated_at
         FROM crm_sync_mapping
        WHERE ${where}
        LIMIT 1`,
      params,
    );
    const row = result.rows[0];
    return row
      ? {
          entityType: row.entity_type,
          erpId: row.erp_id,
          bitrixObject: row.bitrix_object,
          bitrixId: row.bitrix_id,
          parentErpId: row.parent_erp_id,
          status: row.status,
          sourceSystem: row.source_system,
          lastBitrixHash: row.last_bitrix_hash,
          lastBitrixUpdatedAt: row.last_bitrix_updated_at
            ? new Date(row.last_bitrix_updated_at)
            : null,
        }
      : null;
  }
}

interface IncomingRequestAuditSource {
  state?: string | null;
  sync_status?: string | null;
  client_id?: string | number | null;
  title?: string | null;
  crm_amount?: string | number | null;
  currency_id?: string | null;
  stage_id?: string | null;
  assigned_by_id?: string | null;
  comments?: string | null;
}

function incomingRequestAuditFields(
  row: IncomingRequestAuditSource | null | undefined,
): Record<string, unknown> {
  const comments = row?.comments ?? null;
  return {
    orderKind: 'crm_request',
    orderName: row?.title ?? null,
    clientId: row?.client_id === null || row?.client_id === undefined
      ? null
      : Number(row.client_id),
    requestState: row?.state ?? null,
    syncStatus: row?.sync_status ?? null,
    crmAmount: row?.crm_amount === null || row?.crm_amount === undefined
      ? null
      : String(row.crm_amount),
    currencyCode: row?.currency_id ?? null,
    stageId: row?.stage_id ?? null,
    responsibleBitrixUserId: row?.assigned_by_id ?? null,
    commentsPresent: comments !== null && comments.length > 0,
    commentsHash: comments === null
      ? null
      : createHash('sha256').update(comments).digest('hex'),
  };
}

function typedAuditDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  return Object.fromEntries(
    Object.keys(after)
      .filter((key) => before[key] !== after[key])
      .map((key) => [key, { before: before[key] ?? null, after: after[key] ?? null }]),
  );
}

async function recordCrmRequestUpdated(
  tx: TransactionClient,
  audit: AuditService,
  input: {
    orderId: number;
    clientId: number | null;
    requestId: number;
    bitrixDealId: string;
    actorType: 'erp_user' | 'service';
    actorUserId: number | null;
    sourceSystem: 'erp' | 'bitrix24';
    correlationId: string;
    mutationVersion: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
): Promise<void> {
  const diff = typedAuditDiff(input.before, input.after);
  await audit.record(tx, {
    event: 'orders.crm_request_updated',
    entityType: 'order',
    entityId: input.orderId,
    actorUserId: input.actorUserId,
    requestId: input.correlationId,
    source: input.sourceSystem === 'bitrix24' ? 'bitrix24' : 'backend-bitrix24',
    relatedOrderId: input.orderId,
    relatedClientId: input.clientId,
    before: input.before,
    after: input.after,
    diff,
    metadata: {
      bitrixDealId: input.bitrixDealId,
      incomingRequestId: input.requestId,
      actorType: input.actorType,
    },
  });
  await enqueueDomainEvent(tx, {
    eventType: 'orders.crm_request_updated',
    aggregateType: 'order',
    aggregateId: String(input.orderId),
    idempotencyKey:
      `crm-update:${input.bitrixDealId}:${input.sourceSystem}:${input.mutationVersion}`,
    payload: {
      eventVersion: 1,
      eventName: 'orders.crm_request_updated',
      orderId: input.orderId,
      clientId: input.clientId,
      incomingRequestId: input.requestId,
      bitrixDealId: input.bitrixDealId,
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      sourceSystem: input.sourceSystem,
      requestId: input.correlationId,
      before: input.before,
      after: input.after,
      diff,
    },
  });
}

async function recordSyncConflict(
  tx: TransactionClient,
  audit: AuditService,
  input: {
    orderId: number;
    clientId: number | null;
    requestId: number;
    bitrixDealId: string;
    actorUserId: number | null;
    correlationId: string;
    syncVersion: number;
    conflictCode: string;
  },
): Promise<void> {
  await audit.record(tx, {
    event: 'orders.crm_request_sync_conflict',
    entityType: 'order',
    entityId: input.orderId,
    actorUserId: input.actorUserId,
    requestId: input.correlationId,
    source: 'bitrix24',
    relatedOrderId: input.orderId,
    relatedClientId: input.clientId,
    before: { syncStatus: 'ok' },
    after: { syncStatus: 'blocked', conflictCode: input.conflictCode },
    diff: {
      syncStatus: { before: 'ok', after: 'blocked' },
      conflictCode: { before: null, after: input.conflictCode },
    },
    metadata: {
      bitrixDealId: input.bitrixDealId,
      incomingRequestId: input.requestId,
    },
  });
  await enqueueDomainEvent(tx, {
    eventType: 'orders.crm_request_sync_conflict',
    aggregateType: 'order',
    aggregateId: String(input.orderId),
    idempotencyKey:
      `crm-conflict:${input.bitrixDealId}:${input.syncVersion}:${input.conflictCode}`,
    payload: {
      eventVersion: 1,
      eventName: 'orders.crm_request_sync_conflict',
      orderId: input.orderId,
      clientId: input.clientId,
      incomingRequestId: input.requestId,
      bitrixDealId: input.bitrixDealId,
      actorType: 'service',
      actorUserId: input.actorUserId,
      sourceSystem: 'bitrix24',
      conflictCode: input.conflictCode,
      requestId: input.correlationId,
    },
  });
}

async function setReverseOrigin(tx: TransactionClient): Promise<void> {
  await tx.query(`SELECT set_config('app.crm_sync_origin', 'bitrix24', true)`);
}

async function assertInboundOwnership(
  tx: TransactionClient,
  inboundEventId: string,
  lockToken?: string,
): Promise<void> {
  if (!lockToken) return;
  const result = await tx.query(
    `SELECT 1
       FROM bitrix24_inbound_event
      WHERE inbound_event_id=$1 AND status='processing' AND lock_token=$2
      FOR SHARE`,
    [inboundEventId, lockToken],
  );
  if (result.rowCount !== 1) {
    throw new Error('Bitrix24 reverse event ownership lost');
  }
}

async function lockAggregate(tx: TransactionClient, key: string): Promise<void> {
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`bitrix24-reverse:${key}`],
  );
}

async function assertPaymentSnapshotOwnership(
  tx: TransactionClient,
  bitrixPaymentIds: string[],
  expected: { requestId: number | null; orderId: number | null },
): Promise<void> {
  if (bitrixPaymentIds.length === 0) return;
  const conflictRow = await tx.query<{ bitrix_payment_id: string }>(
    `SELECT bitrix_payment_id
       FROM bitrix24_incoming_request_payment
      WHERE bitrix_payment_id = ANY($1::text[])
        AND (
          request_id IS DISTINCT FROM $2::bigint
          OR erp_order_id IS DISTINCT FROM $3::bigint
        )
      LIMIT 1
      FOR UPDATE`,
    [bitrixPaymentIds, expected.requestId, expected.orderId],
  );
  if (conflictRow.rowCount === 1) {
    throw conflict(
      'BITRIX24_PAYMENT_OWNER_CONFLICT',
      `Bitrix24 payment ${conflictRow.rows[0].bitrix_payment_id} is linked to another Deal`,
    );
  }
}

async function insertClient(
  tx: TransactionClient,
  snapshot: ReverseClientSnapshot,
): Promise<number> {
  const result = await tx.query<{ client_id: string | number }>(
    `INSERT INTO clients (client_name, person_type, notes, is_active)
     VALUES ($1,$2,$3,true)
     RETURNING client_id`,
    [
      snapshot.name,
      snapshot.objectType === 'company' ? 'legal' : 'individual',
      snapshot.notes,
    ],
  );
  return Number(result.rows[0].client_id);
}

async function upsertMapping(
  tx: TransactionClient,
  input: {
    entityType: 'client' | 'order' | 'payment';
    erpId: string;
    bitrixObject: string;
    bitrixId: string;
    parentErpId: string | null;
    sourceSystem: 'erp' | 'bitrix24';
    normalizedHash: string;
    bitrixUpdatedAt: Date | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO crm_sync_mapping (
       entity_type, erp_id, bitrix_object, bitrix_id, parent_erp_id,
       status, source_system, last_bitrix_hash, last_bitrix_updated_at,
       last_error, attempts, last_synced_at, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,NULL,0,now(),now())
     ON CONFLICT (entity_type, erp_id) DO UPDATE SET
       bitrix_object=EXCLUDED.bitrix_object, bitrix_id=EXCLUDED.bitrix_id,
       parent_erp_id=EXCLUDED.parent_erp_id, status='active',
       source_system=EXCLUDED.source_system,
       last_bitrix_hash=EXCLUDED.last_bitrix_hash,
       last_bitrix_updated_at=EXCLUDED.last_bitrix_updated_at,
       last_error=NULL, attempts=0, last_synced_at=now(), updated_at=now()`,
    [
      input.entityType,
      input.erpId,
      input.bitrixObject,
      input.bitrixId,
      input.parentErpId,
      input.sourceSystem,
      input.normalizedHash,
      input.bitrixUpdatedAt,
    ],
  );
}

async function materializeCrmRequestOrder(
  tx: TransactionClient,
  audit: AuditService,
  snapshot: ReverseDealSnapshot,
  options: ReverseDealMaterializationOptions,
  requestId: string,
): Promise<{ requestId: number; erpOrderId: string }> {
  const prerequisites = await tx.query<{
    actor_user_id: string | number;
    order_status_id: string | number;
    payment_status_id: string | number;
  }>(
    `SELECT actor.user_id AS actor_user_id,
            order_status.order_status_id,
            payment_status.payment_status_id
       FROM users actor
       JOIN roles actor_role ON actor_role.role_id=actor.role_id
       CROSS JOIN order_statuses order_status
       CROSS JOIN payment_statuses payment_status
      WHERE actor.user_id=$1
        AND actor.is_active=true
        AND actor.is_service_account=true
        AND actor_role.role_code='integration_service'
        AND actor_role.is_active=true
        AND order_status.order_status_code='crm_request'
        AND order_status.is_active=true
        AND upper(payment_status.payment_status_code) IN ('NOT_PAID','UNPAID')
        AND payment_status.is_active=true`,
    [options.actorUserId],
  );
  const prerequisite = prerequisites.rows[0];
  if (!prerequisite) {
    throw new ApiError(
      503,
      'BITRIX24_REVERSE_PREREQUISITE_INVALID',
      'Bitrix24 reverse synchronization service actor or status catalog is invalid',
    );
  }

  const existingRequest = await tx.query<{
    request_id: string | number;
    linked_order_id: string | number | null;
  }>(
    `SELECT request_id, linked_order_id
       FROM bitrix24_incoming_request
      WHERE bitrix_deal_id=$1
      FOR UPDATE`,
    [snapshot.bitrixId],
  );
  const currentRequest = existingRequest.rows[0];
  if (currentRequest?.linked_order_id !== null && currentRequest?.linked_order_id !== undefined) {
    throw new ApiError(
      409,
      'BITRIX24_REQUEST_MAPPING_INCONSISTENT',
      'Bitrix24 request already links an order but its CRM mapping is missing',
    );
  }

  const managerId = await resolveMappedManagerId(tx, snapshot.assignedById);
  const order = await tx.query<{ order_id: string | number }>(
    `INSERT INTO orders (
       order_name, client_id, order_date, priority, manager_id,
       order_status_id, payment_status_id, production_status_id,
       production_status_from_details_enabled,
       total_amount, final_amount, discount, surcharge, paid_amount,
       payment_date, parts_count, total_area, project_id,
       order_kind, source_system, legacy_zero_detail_exempt,
       created_by, edited_by, version
     )
     VALUES (
       $1,$2,COALESCE($3::date, CURRENT_DATE),100,$4,
       $5,$6,NULL,false,
       0,0,0,0,0,
       NULL,0,0,NULL,
       'crm_request','bitrix24',false,
       $7,$7,1
     )
     RETURNING order_id`,
    [
      snapshot.title,
      snapshot.clientId,
      snapshot.beginDate,
      managerId,
      prerequisite.order_status_id,
      prerequisite.payment_status_id,
      prerequisite.actor_user_id,
    ],
  );
  const orderId = String(order.rows[0].order_id);

  const request = await tx.query<{ request_id: string | number; version: number }>(
    `INSERT INTO bitrix24_incoming_request (
       bitrix_deal_id, client_id, title, crm_amount, currency_id,
       stage_id, assigned_by_id, begin_date, close_date, comments,
       bitrix_url, state, linked_order_id,
       bitrix_created_at, bitrix_updated_at,
       counterparty_object_type, counterparty_bitrix_id, full_title,
       remote_revision, sync_status
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13,$14,$15,$16,$17,$18,'ok')
     ON CONFLICT (bitrix_deal_id) DO UPDATE SET
       client_id=EXCLUDED.client_id, title=EXCLUDED.title,
       crm_amount=EXCLUDED.crm_amount, currency_id=EXCLUDED.currency_id,
       stage_id=EXCLUDED.stage_id, assigned_by_id=EXCLUDED.assigned_by_id,
       begin_date=EXCLUDED.begin_date, close_date=EXCLUDED.close_date,
       comments=EXCLUDED.comments, bitrix_url=EXCLUDED.bitrix_url,
       state='active', linked_order_id=EXCLUDED.linked_order_id,
       bitrix_created_at=EXCLUDED.bitrix_created_at,
       bitrix_updated_at=EXCLUDED.bitrix_updated_at,
       counterparty_object_type=EXCLUDED.counterparty_object_type,
       counterparty_bitrix_id=EXCLUDED.counterparty_bitrix_id,
       full_title=EXCLUDED.full_title, remote_revision=EXCLUDED.remote_revision,
       sync_status='ok', sync_error_code=NULL, sync_error_at=NULL,
       sync_version=bitrix24_incoming_request.sync_version+1,
       version=bitrix24_incoming_request.version+1, updated_at=now()
     RETURNING request_id, version`,
    [
      snapshot.bitrixId,
      snapshot.clientId,
      snapshot.title,
      snapshot.crmAmount,
      snapshot.currencyId,
      snapshot.stageId,
      snapshot.assignedById,
      snapshot.beginDate,
      snapshot.closeDate,
      snapshot.comments,
      snapshot.bitrixUrl,
      orderId,
      snapshot.bitrixCreatedAt,
      snapshot.bitrixUpdatedAt,
      snapshot.counterpartyObjectType,
      snapshot.counterpartyBitrixId,
      snapshot.fullTitle,
      snapshot.remoteRevision,
    ],
  );
  const incomingRequestId = Number(request.rows[0].request_id);

  await upsertMapping(tx, {
    entityType: 'order',
    erpId: orderId,
    bitrixObject: 'deal',
    bitrixId: snapshot.bitrixId,
    parentErpId: String(snapshot.clientId),
    sourceSystem: 'bitrix24',
    normalizedHash: snapshot.normalizedHash,
    bitrixUpdatedAt: snapshot.bitrixUpdatedAt,
  });
  await upsertRemoteState(tx, {
    objectType: 'deal',
    bitrixId: snapshot.bitrixId,
    erpEntityType: 'order',
    erpId: orderId,
    normalizedHash: snapshot.normalizedHash,
    remoteRevision: snapshot.remoteRevision,
    title: snapshot.fullTitle,
    crmAmount: snapshot.crmAmount,
    currencyId: snapshot.currencyId,
    stageId: snapshot.stageId,
    assignedById: snapshot.assignedById,
    beginDate: snapshot.beginDate,
    closeDate: snapshot.closeDate,
    comments: snapshot.comments,
    bitrixCreatedAt: snapshot.bitrixCreatedAt,
    bitrixUpdatedAt: snapshot.bitrixUpdatedAt,
    rawSnapshot: snapshot.rawSnapshot,
  });
  await audit.record(tx, {
    event: 'orders.crm_request_created',
    entityType: 'order',
    entityId: orderId,
    actorUserId: options.actorUserId,
    requestId,
    source: 'bitrix24',
    relatedOrderId: Number(orderId),
    relatedClientId: snapshot.clientId,
    after: {
      orderKind: 'crm_request',
      orderName: snapshot.title,
      orderDate: snapshot.beginDate,
      clientId: snapshot.clientId,
      managerId,
      projectId: null,
      requestState: 'active',
      syncStatus: 'ok',
      crmAmount: snapshot.crmAmount === null ? null : String(snapshot.crmAmount),
      stageId: snapshot.stageId,
      responsibleBitrixUserId: snapshot.assignedById,
    },
    metadata: { bitrixDealId: snapshot.bitrixId, actorType: 'service' },
  });
  await enqueueDomainEvent(tx, {
    eventType: 'orders.crm_request_created',
    aggregateType: 'order',
    aggregateId: orderId,
    idempotencyKey: `crm-create:${snapshot.bitrixId}:${snapshot.remoteRevision}`,
    payload: {
      eventVersion: 1,
      eventName: 'orders.crm_request_created',
      sourceSystem: 'bitrix24',
      actorType: 'service',
      actorUserId: options.actorUserId,
      orderId: Number(orderId),
      clientId: snapshot.clientId,
      incomingRequestId,
      bitrixDealId: snapshot.bitrixId,
      requestId,
    },
  });
  return { requestId: incomingRequestId, erpOrderId: orderId };
}

async function resolveMappedManagerId(
  tx: TransactionClient,
  bitrixUserId: string | null,
): Promise<number | null> {
  if (!bitrixUserId) return null;
  const manager = await tx.query<{ erp_user_id: string | number }>(
    `SELECT mapping.erp_user_id
       FROM bitrix24_user_mapping mapping
       JOIN users target ON target.user_id=mapping.erp_user_id
      WHERE mapping.bitrix_user_id=$1
        AND mapping.is_active=true
        AND target.is_active=true
        AND target.is_service_account=false
      LIMIT 1`,
    [bitrixUserId],
  );
  return manager.rows[0] ? Number(manager.rows[0].erp_user_id) : null;
}

async function upsertRemoteState(
  tx: TransactionClient,
  input: {
    objectType: Bitrix24ReverseObjectType;
    bitrixId: string;
    erpEntityType: 'client' | 'order' | null;
    erpId: string | null;
    normalizedHash: string;
    remoteRevision?: string | null;
    title: string | null;
    crmAmount?: number | null;
    currencyId?: string | null;
    stageId?: string | null;
    assignedById?: string | null;
    beginDate?: string | null;
    closeDate?: string | null;
    comments?: string | null;
    bitrixCreatedAt: Date | null;
    bitrixUpdatedAt: Date | null;
    rawSnapshot: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO bitrix24_remote_state (
       object_type, bitrix_id, erp_entity_type, erp_id, normalized_hash,
       title, crm_amount, currency_id, stage_id, assigned_by_id,
       begin_date, close_date, comments, bitrix_created_at, bitrix_updated_at,
       raw_snapshot, remote_revision, is_deleted, deleted_at,
       last_fetched_at, last_applied_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,false,NULL,now(),now())
     ON CONFLICT (object_type, bitrix_id) DO UPDATE SET
       erp_entity_type=EXCLUDED.erp_entity_type, erp_id=EXCLUDED.erp_id,
       normalized_hash=EXCLUDED.normalized_hash, title=EXCLUDED.title,
       crm_amount=EXCLUDED.crm_amount, currency_id=EXCLUDED.currency_id,
       stage_id=EXCLUDED.stage_id, assigned_by_id=EXCLUDED.assigned_by_id,
       begin_date=EXCLUDED.begin_date, close_date=EXCLUDED.close_date,
       comments=EXCLUDED.comments,
       bitrix_created_at=EXCLUDED.bitrix_created_at,
       bitrix_updated_at=EXCLUDED.bitrix_updated_at,
       raw_snapshot=EXCLUDED.raw_snapshot,
       remote_revision=EXCLUDED.remote_revision,
       is_deleted=false, deleted_at=NULL,
       last_fetched_at=now(), last_applied_at=now()`,
    [
      input.objectType,
      input.bitrixId,
      input.erpEntityType,
      input.erpId,
      input.normalizedHash,
      input.title,
      input.crmAmount ?? null,
      input.currencyId ?? null,
      input.stageId ?? null,
      input.assignedById ?? null,
      input.beginDate ?? null,
      input.closeDate ?? null,
      input.comments ?? null,
      input.bitrixCreatedAt,
      input.bitrixUpdatedAt,
      JSON.stringify(input.rawSnapshot),
      input.remoteRevision ?? null,
    ],
  );
}

async function materializeActivePayments(
  tx: TransactionClient,
  requestId: number,
  orderId: number,
  includeMaterialized = true,
): Promise<number> {
  const result = await tx.query<MaterializablePaymentRow>(
    `SELECT payment.bitrix_payment_id, payment.pay_system_id,
            payment.amount, payment.payment_date, payment.normalized_hash,
            payment.sync_version,
            payment.erp_payment_id, mapping.type_paid_id
       FROM bitrix24_incoming_request_payment payment
       LEFT JOIN bitrix24_payment_type_mapping mapping
         ON mapping.pay_system_id=payment.pay_system_id AND mapping.active=true
      WHERE payment.request_id=$1
        AND (
          payment.state='active'
          OR ($2::boolean AND payment.state='materialized')
        )
        AND payment.paid=true
      ORDER BY payment.bitrix_payment_id
      FOR UPDATE OF payment`,
    [requestId, includeMaterialized],
  );
  return materializePaymentRows(tx, result.rows, orderId);
}

async function materializeMappedOrderPaymentRows(
  tx: TransactionClient,
  orderId: number,
): Promise<number> {
  const result = await tx.query<MaterializablePaymentRow>(
    `SELECT payment.bitrix_payment_id, payment.pay_system_id,
            payment.amount, payment.payment_date, payment.normalized_hash,
            payment.sync_version,
            payment.erp_payment_id, mapping.type_paid_id
       FROM bitrix24_incoming_request_payment payment
       LEFT JOIN bitrix24_payment_type_mapping mapping
         ON mapping.pay_system_id=payment.pay_system_id AND mapping.active=true
      WHERE payment.erp_order_id=$1
        AND payment.state IN ('active','materialized')
        AND payment.paid=true
      ORDER BY payment.bitrix_payment_id
      FOR UPDATE OF payment`,
    [orderId],
  );
  return materializePaymentRows(tx, result.rows, orderId);
}

interface MaterializablePaymentRow {
  bitrix_payment_id: string;
  pay_system_id: number | null;
  amount: string | number;
  payment_date: Date | string | null;
  normalized_hash: string;
  sync_version: string | number;
  erp_payment_id: string | number | null;
  type_paid_id: string | number | null;
}

async function materializePaymentRows(
  tx: TransactionClient,
  rows: MaterializablePaymentRow[],
  orderId: number,
): Promise<number> {
  let changed = 0;
  for (const payment of rows) {
    if (payment.type_paid_id === null) {
      throw conflict(
        'BITRIX24_PAYMENT_SYSTEM_UNMAPPED',
        `Bitrix24 payment system ${payment.pay_system_id ?? 'unknown'} is not mapped`,
      );
    }
    const amount = Number(payment.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw conflict(
        'BITRIX24_PAYMENT_AMOUNT_INVALID',
        `Bitrix24 payment ${payment.bitrix_payment_id} has invalid amount`,
      );
    }
    const paymentDate = toDate(payment.payment_date) ?? new Date().toISOString().slice(0, 10);
    let paymentChanged = payment.erp_payment_id === null;
    let erpPaymentId = payment.erp_payment_id === null
      ? null
      : Number(payment.erp_payment_id);
    if (erpPaymentId === null) {
      const inserted = await tx.query<{ payment_id: string | number }>(
        `INSERT INTO payments (
           order_id, amount, payment_date, type_paid_id, notes,
           ref_key_1c, delete_flag
         )
         VALUES ($1,$2,$3,$4,$5,NULL,false)
         RETURNING payment_id`,
        [
          orderId,
          amount,
          paymentDate,
          payment.type_paid_id,
          `Платёж из Bitrix24 #${payment.bitrix_payment_id}`,
        ],
      );
      erpPaymentId = Number(inserted.rows[0].payment_id);
    } else {
      const updated = await tx.query(
        `UPDATE payments
            SET order_id=$2, amount=$3, payment_date=$4, type_paid_id=$5,
                notes=$6, delete_flag=false, updated_at=now()
          WHERE payment_id=$1
            AND (order_id, amount, payment_date, type_paid_id, notes, delete_flag)
                IS DISTINCT FROM
                ($2::bigint, $3::numeric, $4::date, $5::integer, $6::text, false)`,
        [
          erpPaymentId,
          orderId,
          amount,
          paymentDate,
          payment.type_paid_id,
          `Платёж из Bitrix24 #${payment.bitrix_payment_id}`,
        ],
      );
      if (updated.rowCount !== 1) {
        const existing = await tx.query(
          'SELECT 1 FROM payments WHERE payment_id=$1',
          [erpPaymentId],
        );
        if (existing.rowCount !== 1) {
          throw conflict(
            'BITRIX24_ERP_PAYMENT_MISSING',
            `ERP payment ${erpPaymentId} linked to Bitrix24 is missing`,
          );
        }
        paymentChanged = false;
      } else {
        paymentChanged = true;
      }
    }
    await tx.query(
      `UPDATE bitrix24_incoming_request_payment
          SET state='materialized', erp_payment_id=$2, updated_at=now()
        WHERE bitrix_payment_id=$1`,
      [payment.bitrix_payment_id, erpPaymentId],
    );
    await upsertMapping(tx, {
      entityType: 'payment',
      erpId: String(erpPaymentId),
      bitrixObject: 'payment',
      bitrixId: payment.bitrix_payment_id,
      parentErpId: String(orderId),
      sourceSystem: 'bitrix24',
      normalizedHash: payment.normalized_hash,
      bitrixUpdatedAt: null,
    });
    if (paymentChanged) {
      await enqueueDomainEvent(tx, {
        eventType: 'bitrix24.payment.materialized',
        aggregateType: 'payment',
        aggregateId: String(erpPaymentId),
        idempotencyKey:
          `bitrix24.payment.materialized:${payment.bitrix_payment_id}:${payment.sync_version}`,
        payload: {
          paymentId: erpPaymentId,
          orderId,
          bitrixPaymentId: payment.bitrix_payment_id,
          source: 'bitrix24',
        },
      });
      changed += 1;
    }
  }
  return changed;
}

async function recalculatePaymentState(
  tx: TransactionClient,
  orderId: number,
): Promise<void> {
  const order = await tx.query<{
    final_amount: string | number | null;
    payment_status_id: string | number;
    version: string | number;
  }>(
    `SELECT final_amount, payment_status_id, version
       FROM orders
      WHERE order_id=$1 AND delete_flag=false
      FOR UPDATE`,
    [orderId],
  );
  const row = order.rows[0];
  if (!row) throw notFound('ORDER_NOT_FOUND', 'Order not found');
  const totals = await tx.query<{
    paid_amount: string | number;
    payment_date: Date | string | null;
  }>(
    `SELECT COALESCE(SUM(amount),0) AS paid_amount,
            MAX(payment_date) AS payment_date
       FROM payments
      WHERE order_id=$1 AND delete_flag=false`,
    [orderId],
  );
  const paidAmount = roundMoney(Number(totals.rows[0]?.paid_amount ?? 0));
  const finalAmount = roundMoney(Number(row.final_amount ?? 0));
  const paymentStatusId = calculatePaymentStatusId(
    Number(row.payment_status_id),
    finalAmount,
    paidAmount,
  );
  await tx.query(
    `UPDATE orders
        SET paid_amount=$2, payment_date=$3, payment_status_id=$4,
            version=$5
      WHERE order_id=$1`,
    [
      orderId,
      paidAmount,
      toDate(totals.rows[0]?.payment_date ?? null),
      paymentStatusId,
      Number(row.version) + 1,
    ],
  );
}

async function consumeSuppression(
  tx: TransactionClient,
  objectType: string,
  bitrixId: string,
  operation: 'update' | 'delete',
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE bitrix24_outbound_operation
        SET status='observed', observed_at=now()
      WHERE operation_id = (
        SELECT operation_id
          FROM bitrix24_outbound_operation
         WHERE object_type=$1 AND bitrix_id=$2 AND operation=$3
           AND status IN ('prepared','completed') AND expires_at > now()
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING operation_id`,
    [objectType, bitrixId, operation],
  );
  return result.rowCount === 1;
}

async function enqueueDomainEvent(
  tx: TransactionClient,
  input: {
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO outbox_events (
       event_type, aggregate_type, aggregate_id, payload_json, idempotency_key
     )
     VALUES ($1,$2,$3,$4::jsonb,$5)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      JSON.stringify(input.payload),
      input.idempotencyKey,
    ],
  );
}

async function enqueueUnresolvedDealsForCounterparty(
  tx: TransactionClient,
  objectType: 'contact' | 'company',
  bitrixId: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO bitrix24_inbound_event (
       member_id, event_name, object_type, bitrix_id, event_ts,
       payload_json, fingerprint
     )
     SELECT installation.member_id, 'BITRIX24_RECONCILE_DEAL', 'deal',
            request.bitrix_deal_id, now(),
            jsonb_build_object(
              'source','counterparty-resume',
              'counterpartyObjectType',$1,
              'counterpartyBitrixId',$2
            ),
            'counterparty-resume:' || $1 || ':' || $2 || ':deal:' ||
              request.bitrix_deal_id || ':' || COALESCE(request.remote_revision,'legacy')
       FROM bitrix24_incoming_request request
       CROSS JOIN LATERAL (
         SELECT member_id
           FROM bitrix24_app_installation
          WHERE status <> 'revoked'
          ORDER BY updated_at DESC
          LIMIT 1
       ) installation
      WHERE request.state='unresolved'
        AND request.counterparty_object_type=$1
        AND request.counterparty_bitrix_id=$2
     ON CONFLICT (member_id, fingerprint) DO NOTHING`,
    [objectType, bitrixId],
  );
}

interface IncomingRequestDetailRow {
  detail_id: string | number;
  detail_number: string | number;
  detail_name: string | null;
  height: string | number;
  width: string | number;
  quantity: string | number;
  area: string | number;
  sheet_material_type_id: string | number;
  milling_type_id: string | number;
  edge_type_id: string | number;
  film_id: string | number | null;
  milling_cost_per_sqm: string | number | null;
  detail_cost: string | number | null;
  priority: string | number;
  note: string | null;
}

function mapIncomingRequestDetail(
  row: IncomingRequestDetailRow,
  canViewFinancials = true,
) {
  return {
    id: Number(row.detail_id),
    detailNumber: Number(row.detail_number),
    detailName: row.detail_name,
    height: Number(row.height),
    width: Number(row.width),
    quantity: Number(row.quantity),
    area: Number(row.area),
    sheetMaterialTypeId: Number(row.sheet_material_type_id),
    millingTypeId: Number(row.milling_type_id),
    edgeTypeId: Number(row.edge_type_id),
    filmId: row.film_id === null ? null : Number(row.film_id),
    ...(canViewFinancials ? {
      millingCostPerSqm:
        row.milling_cost_per_sqm === null ? null : Number(row.milling_cost_per_sqm),
      detailCost: row.detail_cost === null ? null : Number(row.detail_cost),
    } : {}),
    priority: Number(row.priority),
    note: row.note,
  };
}

async function assertIncomingDetailReferences(
  tx: TransactionClient,
  details: IncomingRequestDetailInput[],
): Promise<void> {
  const references = await tx.query<{
    invalid_sheet_ids: Array<string | number>;
    invalid_milling_ids: Array<string | number>;
    invalid_edge_ids: Array<string | number>;
    invalid_film_ids: Array<string | number>;
  }>(
    `SELECT
       ARRAY(SELECT DISTINCT id FROM unnest($1::bigint[]) AS source(id)
              LEFT JOIN sheet_material_types target ON target.sheet_material_type_id=source.id
             WHERE target.sheet_material_type_id IS NULL) AS invalid_sheet_ids,
       ARRAY(SELECT DISTINCT id FROM unnest($2::bigint[]) AS source(id)
              LEFT JOIN milling_types target ON target.milling_type_id=source.id
             WHERE target.milling_type_id IS NULL) AS invalid_milling_ids,
       ARRAY(SELECT DISTINCT id FROM unnest($3::bigint[]) AS source(id)
              LEFT JOIN edge_types target ON target.edge_type_id=source.id
             WHERE target.edge_type_id IS NULL) AS invalid_edge_ids,
       ARRAY(SELECT DISTINCT id FROM unnest($4::bigint[]) AS source(id)
              LEFT JOIN films target ON target.film_id=source.id
             WHERE target.film_id IS NULL) AS invalid_film_ids`,
    [
      details.map((detail) => detail.sheetMaterialTypeId),
      details.map((detail) => detail.millingTypeId),
      details.map((detail) => detail.edgeTypeId),
      details.flatMap((detail) => detail.filmId == null ? [] : [detail.filmId]),
    ],
  );
  const invalid = references.rows[0];
  const fields = [
    ['sheetMaterialTypeId', invalid?.invalid_sheet_ids ?? []],
    ['millingTypeId', invalid?.invalid_milling_ids ?? []],
    ['edgeTypeId', invalid?.invalid_edge_ids ?? []],
    ['filmId', invalid?.invalid_film_ids ?? []],
  ] as const;
  const issue = fields.find(([, ids]) => ids.length > 0);
  if (issue) {
    throw new ApiError(422, 'DETAIL_REFERENCE_NOT_FOUND', 'Detail reference not found', {
      field: issue[0],
      ids: issue[1].map(Number),
    });
  }
}

function notFound(code: string, message: string): ApiError {
  return new ApiError(404, code, message);
}

function conflict(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDate(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}
