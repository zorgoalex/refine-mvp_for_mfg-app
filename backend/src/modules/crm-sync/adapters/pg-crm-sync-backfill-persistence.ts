import type { AuditService } from '../../../common/audit/audit.service';
import type { DatabaseService } from '../../../database/database.service';
import type { SyncIntent } from '../application/bitrix24-sync-consumer';
import type {
  BackfillCheckpoint,
  BackfillScope,
} from '../application/crm-sync-backfill';
import type { PgCrmSyncMappingRepository } from './pg-crm-sync-mapping-repository';
import type { PgCrmSyncOutboxRepository } from './pg-crm-sync-outbox-repository';
import type { PgCrmSyncBackfillCheckpointRepository } from './pg-crm-sync-backfill-checkpoint-repository';

export class BackfillWriterOwnershipLostError extends Error {
  constructor() {
    super('Bitrix24 backfill writer ownership lost');
    this.name = 'BackfillWriterOwnershipLostError';
  }
}

/**
 * Fences every backfill write with the live writer token inside the same
 * transaction as mappings, audit rows and the durable cursor.
 */
export class PgCrmSyncBackfillPersistence {
  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: PgCrmSyncOutboxRepository,
    private readonly mapping: PgCrmSyncMappingRepository,
    private readonly audit: AuditService,
    private readonly checkpoints: PgCrmSyncBackfillCheckpointRepository,
  ) {}

  async persist(
    writerToken: string,
    intents: SyncIntent[],
    checkpoint: BackfillCheckpoint,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (!await this.outbox.heartbeatWriterLock(tx, writerToken)) {
        throw new BackfillWriterOwnershipLostError();
      }
      for (const intent of intents) {
        await this.mapping.upsertSuccess(tx, intent.mapping);
        await this.audit.record(tx, intent.audit);
        if (intent.clearPaymentCreateGuardId) {
          await this.mapping.deletePaymentCreateGuard(
            tx,
            intent.clearPaymentCreateGuardId,
          );
        }
      }
      await this.checkpoints.save(tx, checkpoint);
    });
  }

  async reset(
    writerToken: string,
    scope: BackfillScope,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (!await this.outbox.heartbeatWriterLock(tx, writerToken)) {
        throw new BackfillWriterOwnershipLostError();
      }
      await this.checkpoints.reset(tx, scope);
    });
  }
}
