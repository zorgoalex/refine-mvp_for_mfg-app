import { ApiError } from '../../../common/errors/api-error';
import type {
  DeleteMdfBoardManualMoveCommand,
  ListMdfBoardManualMovesCommand,
  MdfBoardManualMoveRepositoryPort,
  UpsertMdfBoardManualMoveCommand,
} from '../application/mdf-board-manual-move.types';
import type {
  MdfBoardManualMoveDeleteResponseDto,
  MdfBoardManualMovesResponseDto,
  MdfBoardManualMoveUpsertResponseDto,
} from '../dto/mdf-board-manual-move.dto';

export class UnavailableMdfBoardManualMoveRepository implements MdfBoardManualMoveRepositoryPort {
  async list(_command: ListMdfBoardManualMovesCommand): Promise<MdfBoardManualMovesResponseDto> {
    throw unavailable();
  }

  async upsert(_command: UpsertMdfBoardManualMoveCommand): Promise<MdfBoardManualMoveUpsertResponseDto> {
    throw unavailable();
  }

  async delete(_command: DeleteMdfBoardManualMoveCommand): Promise<MdfBoardManualMoveDeleteResponseDto> {
    throw unavailable();
  }
}

function unavailable(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'MDF board manual moves adapter is not configured', {
    feature: 'mdf_board_manual_moves',
    adapter: 'mdf_board_manual_move_repository',
  });
}
