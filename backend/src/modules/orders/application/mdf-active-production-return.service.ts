import type { DatabaseService } from '../../../database/database.service';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgMdfCorrectionCommand } from '../../mdf-board/adapters/mdf-correction-command';
import type {
  MdfCorrectionConfirmBody,
  MdfCorrectionConfirmResponse,
  MdfCorrectionPreviewBody,
  MdfCorrectionPreviewResponse,
  MdfCorrectionSourceRef,
} from '../../mdf-board/application/mdf-correction.types';

/** HTTP-facing facade. The MDF adapter owns the READ COMMITTED transaction and
 * locked engine boundary; this service deliberately opens no transaction. */
export interface MdfEngineModeDto {
  mode: 'legacy' | 'shadow' | 'active' | 'read_only';
  publishedReads: boolean;
}

export class MdfActiveProductionReturnService {
  private readonly command: PgMdfCorrectionCommand;

  constructor(private readonly database: Pick<DatabaseService, 'transaction'>) {
    this.command = new PgMdfCorrectionCommand(database);
  }

  /** §5.5 authoritative engine mode for the board's return dialog (legacy dialog only in legacy/shadow). Read-only:
   * the shared cutover lock orders it against a mode switch; nothing is written. */
  async engineMode(currentUser: CurrentUser): Promise<MdfEngineModeDto> {
    if (!currentUser.permissions.includes('orders.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав');
    }
    return this.database.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('mdf-engine-cutover',0))");
      const rows = (await tx.query<{ mode: string }>('SELECT mode FROM mdf_engine_state WHERE singleton=true')).rows;
      const mode = rows[0]?.mode;
      if (rows.length !== 1 || !['legacy', 'shadow', 'active', 'read_only'].includes(mode ?? '')) {
        throw new ApiError(503, 'MDF_ENGINE_STATE_UNAVAILABLE', 'Не удалось определить режим производственного учёта');
      }
      return { mode: mode as MdfEngineModeDto['mode'], publishedReads: process.env.BACKEND_MDF_PUBLISHED_READS === 'true' };
    });
  }

  preview(
    currentUser: CurrentUser,
    source: MdfCorrectionSourceRef,
    request: MdfCorrectionPreviewBody,
    requestId: string,
  ): Promise<MdfCorrectionPreviewResponse> {
    return this.command.preview(currentUser, source, request, requestId);
  }

  confirm(
    currentUser: CurrentUser,
    source: MdfCorrectionSourceRef,
    request: MdfCorrectionConfirmBody,
    requestId: string,
  ): Promise<MdfCorrectionConfirmResponse> {
    return this.command.confirm(currentUser, source, request, requestId);
  }
}
