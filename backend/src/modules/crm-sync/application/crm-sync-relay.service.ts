import { Logger, type LoggerService } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { redactLogFields } from '../../../common/logging/redaction';
import type { DatabaseService } from '../../../database/database.service';
import type { AuditService } from '../../../common/audit/audit.service';
import type {
  ClaimedCrmSyncOutboxEvent,
  PgCrmSyncOutboxRepository,
} from '../adapters/pg-crm-sync-outbox-repository';
import type { PgCrmSyncMappingRepository } from '../adapters/pg-crm-sync-mapping-repository';
import {
  CrmSyncTargetError,
  type Bitrix24SyncConsumer,
} from './bitrix24-sync-consumer';
import type { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';

export interface RelayTickResult {
  claimed: number;
  processed: number;
  failed: number;
}

/** Module-local sentinel: thrown inside a tx when lock_token no longer matches (row reclaimed). */
class OwnershipLost extends Error {
  constructor() {
    super('crm-sync: ownership lost (row reclaimed by another worker)');
    this.name = 'OwnershipLost';
  }
}

interface CrmSyncRelayServiceDeps {
  outboxRepo: PgCrmSyncOutboxRepository;
  consumer: Bitrix24SyncConsumer;
  dryRunConsumer: Bitrix24SyncConsumer;
  mapping: PgCrmSyncMappingRepository;
  audit: AuditService;
  db: DatabaseService;
  config: CrmSyncRuntimeConfigService;
  logger?: LoggerService;
}

/**
 * CRM-sync relay: claims a batch of outbox events, calls Bitrix24 HTTP (outside any tx),
 * then persists results in a short tx — proving ownership (lock_token) BEFORE any side effect.
 *
 * Key invariants:
 * - No DB tx is held across consumer.sync() HTTP calls.
 * - markProcessed / markRetry use lock_token → stale workers get rowCount=0 → skip all side effects.
 * - dryRun path uses peekPending (no claim) + dryRunConsumer (Noop) → zero DB/Bitrix24 mutations.
 */
export class CrmSyncRelayService {
  private readonly outboxRepo: PgCrmSyncOutboxRepository;
  private readonly consumer: Bitrix24SyncConsumer;
  private readonly dryRunConsumer: Bitrix24SyncConsumer;
  private readonly mapping: PgCrmSyncMappingRepository;
  private readonly audit: AuditService;
  private readonly db: DatabaseService;
  private readonly config: CrmSyncRuntimeConfigService;
  private readonly logger: LoggerService;

  constructor(deps: CrmSyncRelayServiceDeps) {
    this.outboxRepo = deps.outboxRepo;
    this.consumer = deps.consumer;
    this.dryRunConsumer = deps.dryRunConsumer;
    this.mapping = deps.mapping;
    this.audit = deps.audit;
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger ?? new Logger(CrmSyncRelayService.name);
  }

  async runTick(opts?: { dryRun?: boolean }): Promise<RelayTickResult> {
    const flags = this.config.getFlags();

    // Honor explicit dry-run and the runtime BACKEND_BITRIX24_SYNC_DRY_RUN flag.
    // flag (flags.dryRun). A direct runTick() with the env flag set must NOT do live sync.
    const effectiveDryRun = opts?.dryRun === true || flags.dryRun;

    // ── Dry-run path ──────────────────────────────────────────────────────────
    // Triggered by opts.dryRun === true OR flags.dryRun, REGARDLESS of flags.enabled.
    // Uses peekPending (no claim/lock) + Noop consumer (zero real Bitrix24 writes).
    if (effectiveDryRun) {
      const events = await this.outboxRepo.peekPending(this.db, flags.batchSize);
      for (const event of events) {
        try {
          const intents = await this.dryRunConsumer.sync(event);
          this.logger.log(
            redactLogFields({
              event: 'crm_sync_relay_dry_run_peek',
              outboxEventId: event.outboxEventId,
              eventType: event.eventType,
              intentCount: intents.length,
              intents: intents.map((i) => ({
                entityType: i.mapping.entityType,
                erpId: i.mapping.erpId,
                bitrixObject: i.mapping.bitrixObject,
              })),
            }),
          );
        } catch (err) {
          this.logger.log(
            redactLogFields({
              event: 'crm_sync_relay_dry_run_error',
              outboxEventId: event.outboxEventId,
              errorMessage: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
      // Dry-run: no claim, no markProcessed/markRetry, no tx writes. Rows stay pending.
      return { claimed: events.length, processed: 0, failed: 0 };
    }

    // ── Normal path ───────────────────────────────────────────────────────────
    // Fail-closed: if sync is disabled or no relay owner, do nothing (zero writes).
    if (!flags.enabled || flags.relayOwner === 'none') {
      return { claimed: 0, processed: 0, failed: 0 };
    }

    const lockedResult = await this.db.withAdvisoryLock(
      'bitrix24-live-writer',
      async (assertAdvisoryOwned) => {
    const writerToken = randomUUID();
    const writerAcquired = await this.outboxRepo.acquireWriterLock(
      this.db,
      writerToken,
      flags.leaseMs,
    );
    if (!writerAcquired) {
      return { claimed: 0, processed: 0, failed: 0 };
    }

    let claimed: ClaimedCrmSyncOutboxEvent[];
    try {
      claimed = await this.outboxRepo.claimBatch(
        this.db,
        flags.workerId,
        flags.batchSize,
        flags.leaseMs,
      );
    } catch (error) {
      await this.outboxRepo.releaseWriterLock(this.db, writerToken).catch(() => undefined);
      throw error;
    }
    const activeEvents = new Map(
      claimed.map((event) => [event.outboxEventId, event]),
    );
    let heartbeatRunning = false;
    let writerOwnershipLost = false;
    const heartbeat = async () => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      try {
        await assertAdvisoryOwned();
        const writerOwned = await this.outboxRepo.heartbeatWriterLock(this.db, writerToken);
        const eventOwnership = await Promise.all(
          [...activeEvents.values()].map((event) =>
            this.outboxRepo.heartbeat(
              this.db,
              event.outboxEventId,
              event.lockToken,
            )),
        );
        if (!writerOwned || eventOwnership.some((owned) => !owned)) {
          writerOwnershipLost = true;
        }
      } catch (error) {
        writerOwnershipLost = true;
        this.logger.error(redactLogFields({
          event: 'crm_sync_lease_heartbeat_error',
          errorMessage: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        heartbeatRunning = false;
      }
    };
    const heartbeatTimer = setInterval(
      () => void heartbeat(),
      Math.max(1000, Math.floor(flags.leaseMs / 3)),
    );
    heartbeatTimer.unref();

    let processed = 0;
    let failed = 0;

    try {
      for (const event of claimed) {
      if (writerOwnershipLost || !await proveOwnership(
        assertAdvisoryOwned,
        this.outboxRepo,
        this.db,
        writerToken,
        event,
      )) {
        writerOwnershipLost = true;
        break;
      }
      // Step 1: call Bitrix24 HTTP outside any transaction.
      let intents: Awaited<ReturnType<Bitrix24SyncConsumer['sync']>>;
      try {
        intents = await this.consumer.sync(event, async () => {
          if (writerOwnershipLost || !await proveOwnership(
            assertAdvisoryOwned,
            this.outboxRepo,
            this.db,
            writerToken,
            event,
          )) {
            writerOwnershipLost = true;
            throw new OwnershipLost();
          }
        });
      } catch (err) {
        if (writerOwnershipLost || !await proveOwnership(
          assertAdvisoryOwned,
          this.outboxRepo,
          this.db,
          writerToken,
          event,
        )) {
          writerOwnershipLost = true;
          break;
        }
        // consumer.sync threw → mark for retry (or failed if exhausted).
        //
        // Finalize ATOMICALLY in ONE tx, ownership-gated: markRetry token-gated FIRST,
        // markFailed in the SAME tx only when markRetry affected a row. The markRetry
        // UPDATE row-locks the outbox row until COMMIT, so another worker's claimBatch
        // (FOR UPDATE SKIP LOCKED) cannot reclaim it during the window; by the time the
        // row becomes pending+visible (post-commit), markFailed is already applied in the
        // same commit. This closes the unsafe window where a reclaiming worker could
        // upsertSuccess between a pooled markRetry and a pooled markFailed.
        const nextAttemptAt = this.nextAttemptAt(flags.pollIntervalMs);
        const payload = event.payload as {
          entity?: string;
          id?: string;
          op?: string;
          clientId?: string;
        };
        const target = err instanceof CrmSyncTargetError ? err.target : null;
        const entityType = target?.entityType ?? String(payload.entity ?? 'unknown');
        const erpId = target?.erpId ?? String(payload.id ?? event.aggregateId);
        const errMsg = err instanceof Error ? err.message : String(err);

        // Only a STRUCTURALLY VALID payload may write a mapping row:
        //  - entityType must be one of the entity_type CHECK values;
        //    a malformed payload (e.g. 'unknown'/'bogus') would violate the CHECK and roll back the tx.
        //  - erpId must be a numeric id; an invalid id (e.g. 'abc') would write a junk mapping row.
        const validEntity =
          entityType === 'client' || entityType === 'order' || entityType === 'payment';
        const validId = typeof erpId === 'string' && /^\d+$/.test(erpId);
        const payloadClientId =
          typeof payload.clientId === 'string' && /^\d+$/.test(payload.clientId)
            ? Number(payload.clientId)
            : null;
        const bitrixObject =
          target?.bitrixObject ??
          (entityType === 'client' ? 'contact' : entityType === 'payment' ? 'payment' : 'deal');

        const didFail = await this.db.transaction(async (tx) => {
          // markRetry FIRST, token-gated: advances attempts and (when exhausted) flips the row
          // to 'failed'. It MUST commit regardless of payload validity so a malformed event
          // eventually fails closed and becomes a visible 'failed' row instead of looping forever.
          const r = await this.outboxRepo.markRetry(
            tx,
            event.outboxEventId,
            event.lockToken,
            nextAttemptAt,
            flags.maxAttempts,
          );
          // r === 0 → row was lease-reclaimed; skip ALL side effects (no markFailed).
          if (r === 0) {
            return false;
          }
          // markFailed runs in the SAME tx (markRetry row-lock prevents reclaim interleave),
          // but ONLY for a structurally valid payload so it never violates the entity_type
          // CHECK or writes a junk mapping row for a bad id. For a malformed payload we still
          // commit markRetry (no mapping write) → the outbox row advances toward 'failed'.
          if (validEntity && validId) {
            await this.mapping.markFailed(tx, entityType, erpId, bitrixObject, errMsg);
            await this.audit.record(tx, {
              event: 'crm_sync.failed',
              entityType,
              entityId: erpId,
              requestId: event.outboxEventId,
              source: 'crm-sync',
              actorUserId: null,
              relatedClientId: target?.relatedClientId ?? (
                entityType === 'client' ? Number(erpId) : payloadClientId
              ),
              relatedOrderId: target?.relatedOrderId ?? (
                entityType === 'order' ? Number(erpId) : null
              ),
              relatedPaymentId: target?.relatedPaymentId ?? (
                entityType === 'payment' ? Number(erpId) : null
              ),
              metadata: {
                bitrixObject,
                error: errMsg.slice(0, 1000),
              },
            });
          }
          return true;
        });
        if (didFail) {
          failed++;
        }
        activeEvents.delete(event.outboxEventId);
        continue;
      }

      if (writerOwnershipLost || !await proveOwnership(
        assertAdvisoryOwned,
        this.outboxRepo,
        this.db,
        writerToken,
        event,
      )) {
        writerOwnershipLost = true;
        break;
      }

      // Step 2: ONE short tx — prove ownership FIRST, then persist intents.
      try {
        await this.db.transaction(async (tx) => {
          const n = await this.outboxRepo.markProcessed(tx, event.outboxEventId, event.lockToken);
          if (n === 0) {
            // Row was reclaimed by another worker — rollback and skip all side effects.
            throw new OwnershipLost();
          }
          // Persist intents in order (client intent before order intent).
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
        });
        processed++;
      } catch (e) {
        if (e instanceof OwnershipLost) {
          // Silently skip — not a failure. The reclaiming worker will handle it.
          activeEvents.delete(event.outboxEventId);
          continue;
        }
        // Real persistence error: tx already rolled back (markProcessed undone →
        // row stays 'processing' → will be lease-reclaimed later).
        this.logger.error(
          redactLogFields({
            event: 'crm_sync_relay_persist_error',
            outboxEventId: event.outboxEventId,
            errorMessage: e instanceof Error ? e.message : String(e),
          }),
        );
      }
      activeEvents.delete(event.outboxEventId);
      }
    } finally {
      clearInterval(heartbeatTimer);
      await this.outboxRepo.releaseWriterLock(this.db, writerToken).catch((error) => {
        this.logger.error(redactLogFields({
          event: 'crm_sync_writer_lock_release_error',
          errorMessage: error instanceof Error ? error.message : String(error),
        }));
      });
    }

    return { claimed: claimed.length, processed, failed };
      },
    );
    return lockedResult ?? { claimed: 0, processed: 0, failed: 0 };
  }

  /** Simple fixed-delay backoff: retry after one poll interval. */
  private nextAttemptAt(pollIntervalMs: number): string {
    return new Date(Date.now() + pollIntervalMs).toISOString();
  }
}

async function proveOwnership(
  assertAdvisoryOwned: () => Promise<void>,
  outboxRepo: PgCrmSyncOutboxRepository,
  db: DatabaseService,
  writerToken: string,
  event: ClaimedCrmSyncOutboxEvent,
): Promise<boolean> {
  try {
    await assertAdvisoryOwned();
    const [writerOwned, eventOwned] = await Promise.all([
      outboxRepo.heartbeatWriterLock(db, writerToken),
      outboxRepo.heartbeat(db, event.outboxEventId, event.lockToken),
    ]);
    return writerOwned && eventOwned;
  } catch {
    return false;
  }
}
