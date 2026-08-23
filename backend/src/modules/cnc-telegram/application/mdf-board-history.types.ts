import type { CurrentUser } from '../../../permissions/current-user';
import type {
  MdfBoardHistoryOrderOptionsResponseDto,
  MdfBoardHistoryResponseDto,
} from '../dto/mdf-board-history.dto';

export interface SearchMdfBoardHistoryOrdersCommand {
  currentUser: CurrentUser;
  query: string;
  limit: number;
}

export interface GetMdfBoardHistoryCommand {
  currentUser: CurrentUser;
  orderId: number;
  boardDate?: string | null;
}

export interface MdfBoardHistoryRepositoryPort {
  searchOrders(command: SearchMdfBoardHistoryOrdersCommand): Promise<MdfBoardHistoryOrderOptionsResponseDto>;
  getHistory(command: GetMdfBoardHistoryCommand): Promise<MdfBoardHistoryResponseDto>;
}
