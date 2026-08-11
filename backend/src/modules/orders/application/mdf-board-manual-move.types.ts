import type { CurrentUser } from '../../../permissions/current-user';
import type {
  MdfBoardManualCardKind,
  MdfBoardManualMoveDeleteResponseDto,
  MdfBoardManualMovesResponseDto,
  MdfBoardManualMoveUpsertResponseDto,
  MdfBoardManualTargetColumn,
} from '../dto/mdf-board-manual-move.dto';

export interface ListMdfBoardManualMovesCommand {
  currentUser: CurrentUser;
  requestId?: string;
}

export interface UpsertMdfBoardManualMoveCommand {
  currentUser: CurrentUser;
  cardKind: MdfBoardManualCardKind;
  cardId: string;
  targetColumn: MdfBoardManualTargetColumn;
  requestId?: string;
}

export interface DeleteMdfBoardManualMoveCommand {
  currentUser: CurrentUser;
  cardKind: MdfBoardManualCardKind;
  cardId: string;
  requestId?: string;
}

export interface MdfBoardManualMoveRepositoryPort {
  list(command: ListMdfBoardManualMovesCommand): Promise<MdfBoardManualMovesResponseDto>;
  upsert(command: UpsertMdfBoardManualMoveCommand): Promise<MdfBoardManualMoveUpsertResponseDto>;
  delete(command: DeleteMdfBoardManualMoveCommand): Promise<MdfBoardManualMoveDeleteResponseDto>;
}
