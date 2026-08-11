import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  DeleteMdfBoardManualMoveCommand,
  ListMdfBoardManualMovesCommand,
  MdfBoardManualMoveRepositoryPort,
  UpsertMdfBoardManualMoveCommand,
} from './mdf-board-manual-move.types';
import type {
  MdfBoardManualMoveDeleteResponseDto,
  MdfBoardManualMovesResponseDto,
  MdfBoardManualMoveUpsertResponseDto,
} from '../dto/mdf-board-manual-move.dto';

export interface MdfBoardManualMoveServicePorts {
  moves: MdfBoardManualMoveRepositoryPort;
  permissions?: PermissionsService;
}

export class MdfBoardManualMoveService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: MdfBoardManualMoveServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListMdfBoardManualMovesCommand): Promise<MdfBoardManualMovesResponseDto> {
    this.assertCanView(command.currentUser);
    return this.ports.moves.list(command);
  }

  async upsert(command: UpsertMdfBoardManualMoveCommand): Promise<MdfBoardManualMoveUpsertResponseDto> {
    this.assertCanUpdate(command.currentUser);
    return this.ports.moves.upsert(command);
  }

  async delete(command: DeleteMdfBoardManualMoveCommand): Promise<MdfBoardManualMoveDeleteResponseDto> {
    this.assertCanUpdate(command.currentUser);
    return this.ports.moves.delete(command);
  }

  private assertCanView(user: ListMdfBoardManualMovesCommand['currentUser']): void {
    if (!this.permissions.canUser(user, 'production.tasks.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра МДФ-доски', {
        requiredPermissions: ['production.tasks.view'],
      });
    }
  }

  private assertCanUpdate(user: UpsertMdfBoardManualMoveCommand['currentUser']): void {
    if (!this.permissions.canUser(user, 'production.tasks.update')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для ручного перемещения карточек МДФ-доски', {
        requiredPermissions: ['production.tasks.update'],
      });
    }
  }
}
