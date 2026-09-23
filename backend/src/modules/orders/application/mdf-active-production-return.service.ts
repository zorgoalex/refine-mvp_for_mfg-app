import type { DatabaseService } from '../../../database/database.service';
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
export class MdfActiveProductionReturnService {
  private readonly command: PgMdfCorrectionCommand;

  constructor(database: Pick<DatabaseService, 'transaction'>) {
    this.command = new PgMdfCorrectionCommand(database);
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
