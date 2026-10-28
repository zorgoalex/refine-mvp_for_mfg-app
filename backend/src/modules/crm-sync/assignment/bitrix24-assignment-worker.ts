import { Logger, type LoggerService } from '@nestjs/common';
import { redactLogFields } from '../../../common/logging/redaction';
import { safeBitrixError } from '../../audit/application/bitrix-audit-sanitization';
import { Bitrix24ApiError, type Bitrix24ApiPort } from '../adapters/bitrix24-api-client';
import {
  AssignmentLeaseLost,
  type AssignmentObject,
  type AssignmentRemote,
  type AssignmentSettings,
  type ClaimedAssignmentEntity,
  type PgBitrix24AssignmentRepository,
} from './pg-bitrix24-assignment-repository';

const MINUTE = 60_000;
const BACKOFF_MINUTES = [1, 5, 15, 60];
const WAIT_FOR_MAPPING_MS = 60 * MINUTE;
const ENTITY_TYPE_ID: Record<AssignmentObject, number> = { deal: 2, contact: 3, company: 4 };

export interface AssignmentPolicy {
  /** Worker runs (env flag); the mode in the database decides what it does. */
  enabled: boolean;
  /** ERP users whose records the channel takes over; null = everyone («*»). */
  cohort: ReadonlySet<string> | null;
  /** Current BITRIX24_ASSIGNED_BY_ID: release/restore write only while it equals the channel's stored one. */
  releaseAssignedById: string | null;
}

export interface Bitrix24AssignmentWorkerDeps {
  bitrix: Bitrix24ApiPort;
  store: PgBitrix24AssignmentRepository;
  policy: () => AssignmentPolicy;
  batchSize?: number;
  fanoutBatchSize?: number;
  leaseMs?: number;
  now?: () => number;
  logger?: LoggerService;
}

/**
 * Bitrix24 responsible user (assignedById) of production deals and clients, decided by ERP (migration 270). Runs
 * inside the crm-sync relay tick under its live writer lock. Every write is committed as an in-flight operation
 * before the call and confirmed by reading the object back, so a lost answer or a crash never leaves an unknown
 * change behind; a restore returns objects to their state before the feature.
 */
export class Bitrix24AssignmentWorker {
  private readonly now: () => number;
  private readonly logger: LoggerService;

  constructor(private readonly deps: Bitrix24AssignmentWorkerDeps) {
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? new Logger(Bitrix24AssignmentWorker.name);
  }

  async runDue(requestGuard: () => Promise<void>): Promise<{ processed: number }> {
    const policy = this.deps.policy();
    if (!policy.enabled) return { processed: 0 };
    const settings = await this.deps.store.settings();
    if (settings.mode === 'off') return { processed: 0 };
    await this.deps.store.purgeOldCauses();
    await this.deps.store.advanceFanout(this.deps.fanoutBatchSize ?? 200);
    const claimed = await this.deps.store.claimDue(this.deps.batchSize ?? 20, this.deps.leaseMs ?? 10 * MINUTE);
    let processed = 0;
    for (const entity of claimed) {
      try {
        await this.deps.bitrix.withRequestGuard(requestGuard, () => this.process(entity, policy));
        processed += 1;
      } catch (error) {
        const message = errorText(error);
        this.logger.error(redactLogFields({
          event: 'crm_sync_assignment_error',
          entityType: entity.entityType,
          erpId: entity.erpId,
          errorMessage: message,
        }));
        await this.deps.store.release(entity, new Date(this.now() + MINUTE)).catch(() => undefined);
        if (isOwnershipLost(error)) break;
      }
    }
    return { processed };
  }

  private async process(entity: ClaimedAssignmentEntity, policy: AssignmentPolicy): Promise<void> {
    // The mode is read per entity: a restore may start between two entities of one batch.
    const settings = await this.deps.store.settings();
    const remotes = await this.deps.store.remotes(entity);

    // 1. In-flight writes of any object of the entity, by its own identity (no active CRM mapping is required).
    for (const remote of remotes) {
      if (remote.opId && !await this.recover(entity, remote)) return;
    }

    if (settings.mode === 'off') {
      await this.deps.store.markProcessed(entity, NO_DESIRED);
      return;
    }
    if (settings.mode === 'restore') {
      if (!this.releaseMatches(settings, policy)) {
        await this.deferMismatch(entity);
        return;
      }
      await this.restorePass(entity, settings);
      return;
    }

    // 2. Ordinary assignment needs the current object of the entity.
    const current = await this.deps.store.currentObject(entity.entityType, entity.erpId);
    if (!current) {
      await this.deps.store.defer(entity, new Date(this.now() + WAIT_FOR_MAPPING_MS), {
        code: 'WAITING_FOR_MAPPING',
        countAttempt: false,
      });
      return;
    }
    const remote = await this.deps.store.ensureRemote(entity, current);
    const desired = await this.deps.store.desired(entity.entityType, entity.erpId);
    const inCohort = desired !== null && (policy.cohort === null || policy.cohort.has(desired.erpUserId));
    const desiredRecord = {
      assignedById: inCohort ? desired!.bitrixUserId : null,
      source: inCohort ? desired!.source : null,
      erpUserId: inCohort ? desired!.erpUserId : null,
      orderId: desired?.orderId ?? null,
    };

    let target: string;
    let purpose: 'assign' | 'release';
    if (inCohort) {
      target = desired!.bitrixUserId;
      purpose = 'assign';
    } else if (remote.managed) {
      // A record ERP took over lost its manager (no mapping, outside the cohort): nobody keeps its access.
      if (!settings.releaseAssignedById) {
        await this.deps.store.defer(entity, this.backoff(entity.attempts + 1), {
          code: 'NO_RELEASE_TARGET',
          countAttempt: true,
        });
        return;
      }
      if (!this.releaseMatches(settings, policy)) {
        await this.deferMismatch(entity);
        return;
      }
      target = settings.releaseAssignedById;
      purpose = 'release';
    } else {
      await this.deps.store.markProcessed(entity, desiredRecord);
      return;
    }
    await this.deps.store.rememberDesired(entity, {
      ...desiredRecord,
      assignedById: target,
      source: purpose === 'release' ? 'release' : desiredRecord.source,
    });

    const read = await this.read(remote);
    if (read.missing) {
      // The mapping still points at an object Bitrix24 no longer has: wait for the ordinary sync to fix it.
      await this.deps.store.defer(entity, new Date(this.now() + WAIT_FOR_MAPPING_MS), {
        code: 'OBJECT_NOT_FOUND',
        countAttempt: false,
      });
      return;
    }
    if (read.error) {
      await this.deps.store.defer(entity, this.backoff(entity.attempts + 1), {
        code: 'READ_FAILED',
        message: read.error,
        countAttempt: true,
      });
      return;
    }
    if (read.assignedById === target) {
      if (purpose === 'assign' && !remote.managed) {
        await this.deps.store.enroll(entity, remote, target, await this.deps.store.causeIdsFor(entity));
      }
      await this.deps.store.markProcessed(entity, { ...desiredRecord, assignedById: target, source: purpose === 'release' ? 'release' : desiredRecord.source });
      return;
    }

    await this.write(entity, remote, {
      target,
      purpose,
      generation: settings.generation,
      current: read.assignedById,
      desiredSource: purpose === 'release' ? 'release' : desiredRecord.source,
      desiredOrderId: desiredRecord.orderId,
    });
  }

  /** The release user changed in the configuration but not in the channel: no release/restore write until `set-release`. */
  private releaseMatches(settings: AssignmentSettings, policy: AssignmentPolicy): boolean {
    return settings.releaseAssignedById !== null && settings.releaseAssignedById === policy.releaseAssignedById;
  }

  private async deferMismatch(entity: ClaimedAssignmentEntity): Promise<void> {
    await this.deps.store.defer(entity, new Date(this.now() + WAIT_FOR_MAPPING_MS), {
      code: 'RELEASE_TARGET_MISMATCH',
      message: 'BITRIX24_ASSIGNED_BY_ID differs from the channel release user; run set-release',
      countAttempt: false,
    });
  }

  /** Restore mode: every target of the current generation is brought back, or classified, by its own identity. */
  private async restorePass(entity: ClaimedAssignmentEntity, settings: AssignmentSettings): Promise<void> {
    const remotes = await this.deps.store.remotes(entity);
    for (const remote of remotes) {
      if (remote.restoreGeneration !== settings.generation || remote.restoreOutcome !== 'pending' || remote.opId) continue;
      if (!remote.managed) {
        // Nothing of ERP's stayed on this object (its in-flight write did not take effect).
        await this.deps.store.setRestoreOutcome(remote, settings.generation, 'restored');
        continue;
      }
      if (remote.restoreTarget === null) {
        await this.deps.store.setRestoreOutcome(remote, settings.generation, 'conflict_preserved');
        continue;
      }
      const read = await this.read(remote);
      if (read.missing) {
        await this.deps.store.setRestoreOutcome(remote, settings.generation, 'missing', null);
        continue;
      }
      if (read.error) {
        await this.deps.store.defer(entity, this.backoff(entity.attempts + 1), {
          code: 'READ_FAILED',
          message: read.error,
          countAttempt: true,
        });
        return;
      }
      if (read.assignedById === remote.restoreTarget) {
        await this.deps.store.setRestoreOutcome(remote, settings.generation, 'restored', read.assignedById);
        continue;
      }
      if (read.assignedById !== remote.sentAssignedById) {
        // Changed by hand in Bitrix24 after ERP's write: kept, an operator decides (resolve keep|apply).
        await this.deps.store.setRestoreOutcome(remote, settings.generation, 'conflict_preserved', read.assignedById);
        continue;
      }
      const done = await this.write(entity, remote, {
        target: remote.restoreTarget,
        purpose: 'restore',
        generation: settings.generation,
        current: read.assignedById,
        desiredSource: 'restore',
        desiredOrderId: null,
        // The restore command's causes travel with every target, also after a retry or another target closed them.
        causeIds: [...new Set([...entity.causeIds, ...(remote.restoreCauseIds ?? [])])].sort((a, b) => a - b),
      });
      if (!done) return;
    }
    await this.deps.store.markProcessed(entity, NO_DESIRED);
  }

  /**
   * In-flight write found on a claim: confirm it (with the decision stored at its start) if Bitrix24 shows its target,
   * forget it otherwise. False = the object could not be read; the entity is deferred.
   */
  private async recover(entity: ClaimedAssignmentEntity, remote: AssignmentRemote): Promise<boolean> {
    const read = await this.read(remote);
    if (read.error) {
      await this.deps.store.defer(entity, this.backoff(entity.attempts + 1), {
        code: 'RECOVERY_READ_FAILED',
        message: read.error,
        countAttempt: true,
      });
      return false;
    }
    if (read.missing) {
      await this.deps.store.clearOp(remote, remote.opId!, null, true);
      return true;
    }
    if (read.assignedById === remote.opTarget) {
      await this.deps.store.finalize({ remote, opId: remote.opId! });
      return true;
    }
    await this.deps.store.clearOp(remote, remote.opId!, read.assignedById, false);
    return true;
  }

  /** Commit the operation, call, confirm by reading back. False = deferred (the entity is tried again later). */
  private async write(
    entity: ClaimedAssignmentEntity,
    remote: AssignmentRemote,
    input: {
      target: string;
      purpose: 'assign' | 'release' | 'restore';
      generation: number;
      current: string | null;
      desiredSource: string | null;
      desiredOrderId: string | null;
      causeIds?: number[];
    },
  ): Promise<boolean> {
    const opId = await this.deps.store.beginOp(entity, remote, input);
    const pending: AssignmentRemote = {
      ...remote,
      opId,
      opTarget: input.target,
      opBefore: input.current,
      opEntityVersion: entity.version,
      opCauseIds: input.causeIds ?? entity.causeIds,
      opDesiredSource: input.desiredSource,
      opDesiredOrderId: input.desiredOrderId,
      opGeneration: input.generation,
      opPurpose: input.purpose,
    };
    try {
      await this.deps.bitrix.updateCrmItem(ENTITY_TYPE_ID[remote.bitrixObject], remote.bitrixId, { assignedById: Number(input.target) });
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      // The outcome may be unknown: the operation stays and is confirmed or forgotten on the next claim.
      await this.deps.store.defer(entity, this.backoff(entity.attempts + 1), {
        code: 'WRITE_FAILED',
        message: errorText(error),
        countAttempt: true,
      });
      return false;
    }
    const changeId = await this.deps.store.finalize({ remote: pending, opId });
    if (changeId === null) throw new AssignmentLeaseLost();
    if (input.purpose !== 'restore') {
      await this.deps.store.markProcessed(entity, {
        assignedById: input.target,
        source: input.desiredSource,
        erpUserId: null,
        orderId: null,
      });
    }
    return true;
  }

  private async read(remote: AssignmentRemote): Promise<{ assignedById: string | null; missing: boolean; error: string | null }> {
    try {
      const item = await this.deps.bitrix.getCrmItem(ENTITY_TYPE_ID[remote.bitrixObject], remote.bitrixId);
      const value = String(item.assignedById ?? '');
      return { assignedById: /^[1-9][0-9]*$/.test(value) ? value : null, missing: false, error: null };
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      if (error instanceof Bitrix24ApiError && error.isNotFound) return { assignedById: null, missing: true, error: null };
      return { assignedById: null, missing: false, error: errorText(error) };
    }
  }

  private backoff(attempts: number): Date {
    const minutes = BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1];
    return new Date(this.now() + minutes * MINUTE);
  }
}

const NO_DESIRED = { assignedById: null, source: null, erpUserId: null, orderId: null };

function isOwnershipLost(error: unknown): boolean {
  return error instanceof AssignmentLeaseLost || (error instanceof Error && error.name === 'OwnershipLost');
}

/** Error text for `last_error` and logs: webhook paths and tokens are masked before truncation. */
function errorText(error: unknown): string {
  return safeBitrixError(error instanceof Error ? error.message : String(error));
}
