import { Inject, Injectable, Logger } from '@nestjs/common';
import { PgOnecEtlRepository } from '../adapters/pg-onec-etl-repository';
import { PERSONAL_DATA_TTL_MS, REVOCABLE_ENTITIES } from '../domain/onec-etl';
import { OnecRuntimeConfigService } from '../onec-runtime-config.service';
import { attemptFiles, listEntityFiles, removeQuietly } from './onec-etl-spool';

/**
 * Step 2 of a revocation (plan §21.3): removes every trace of a revoked entity
 * (batches, staging, spool files, the copy). Idempotent; run right after the
 * revocation commits and by every monitor tick until the entity is clean.
 * Also expires personal data not confirmed by a snapshot for 30 days.
 */
@Injectable()
export class OnecEtlRevocationService {
  private readonly logger = new Logger(OnecEtlRevocationService.name);

  constructor(
    @Inject(PgOnecEtlRepository) private readonly etl: PgOnecEtlRepository,
    @Inject(OnecRuntimeConfigService) private readonly runtime: OnecRuntimeConfigService,
  ) {}

  async cleanup(sourceId: number, entityCode: string): Promise<{ filesRemoved: number; clean: boolean }> {
    const { files, reservations } = await this.etl.cleanupRevokedEntity(sourceId, entityCode);
    const dir = this.runtime.get().etlSpoolDir;
    for (const reservation of reservations) {
      try {
        for (const file of attemptFiles(dir, { sourceId, entityCode, batchId: reservation.batchId, token: reservation.owner })) {
          await removeQuietly(file);
        }
        await this.etl.clearReservationFiles(reservation.batchId, reservation.owner);
      } catch (error) {
        this.logger.warn(`1C revoked reservation files not removed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let filesRemoved = 0;
    for (const file of files) {
      try {
        await removeQuietly(file.path);
        await this.etl.clearSpoolPath(file.batchId, file.path);
        filesRemoved += 1;
      } catch (error) {
        // The path stays recorded: the entity is not clean and the next cleanup retries.
        this.logger.warn(`1C revoked spool file not removed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Whatever path lost its database record (rebaseline, abandonment, retries, failed uploads): every file
    // of the entity is found by its name prefix. The sweep runs under a SHARE lock of the entity state and
    // only while the entity is still revoked; restoreEntity takes FOR UPDATE, so a restore (and the new
    // uploads it allows) can never interleave with a delayed sweep deleting their files.
    filesRemoved += await this.etl.transaction(async (tx) => {
      if (!(await this.etl.stillRevokedShared(tx, sourceId, entityCode))) return 0;
      let removed = 0;
      for (const file of await listEntityFiles(dir, sourceId, entityCode)) {
        try {
          await removeQuietly(file);
          removed += 1;
        } catch (error) {
          this.logger.warn(`1C revoked spool file not removed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return removed;
    });
    return { filesRemoved, clean: await this.isClean(sourceId, entityCode) };
  }

  /** Clean = no database trace AND no file of the entity on disk. */
  async isClean(sourceId: number, entityCode: string): Promise<boolean> {
    if (!(await this.etl.revokedEntityClean(this.etl.db, sourceId, entityCode))) return false;
    return (await listEntityFiles(this.runtime.get().etlSpoolDir, sourceId, entityCode)).length === 0;
  }

  async cleanupAll(): Promise<{ revokedCleaned: number; personalRowsExpired: number }> {
    let revokedCleaned = 0;
    for (const { sourceId, entityCode, purged } of await this.etl.listRevokedEntities()) {
      // A crash between the ban and the first cleanup leaves purged_at unset even with no data left.
      if (purged && (await this.isClean(sourceId, entityCode))) continue;
      await this.cleanup(sourceId, entityCode);
      revokedCleaned += 1;
    }
    const personalRowsExpired = await this.etl.expirePersonalData([...REVOCABLE_ENTITIES], PERSONAL_DATA_TTL_MS);
    return { revokedCleaned, personalRowsExpired };
  }
}
