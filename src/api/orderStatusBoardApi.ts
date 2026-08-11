import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  MdfBoardManualMoveCardKind,
  MdfBoardManualMoveDeleteResponse,
  MdfBoardManualMovesResponse,
  MdfBoardManualMoveTargetColumn,
  MdfBoardManualMoveUpsertResponse,
  OrderStatusBoardQuery,
  OrderStatusBoardResponse,
} from './types/orderStatusBoardApi.types';
import { withQuery } from './ordersApi';

export const orderStatusBoardApi = {
  get(query: OrderStatusBoardQuery): Promise<OrderStatusBoardResponse> {
    return httpClient.get<OrderStatusBoardResponse>(
      withQuery(apiRoutes.orders.statusBoard, query),
    );
  },
  listMdfManualMoves(): Promise<MdfBoardManualMovesResponse> {
    return httpClient.get<MdfBoardManualMovesResponse>(
      apiRoutes.orders.statusBoardMdfManualMoves,
    );
  },
  upsertMdfManualMove(
    cardKind: MdfBoardManualMoveCardKind,
    cardId: string,
    targetColumn: MdfBoardManualMoveTargetColumn,
  ): Promise<MdfBoardManualMoveUpsertResponse> {
    const normalizedCardId = assertMdfManualMoveIdentity(cardKind, cardId);
    return httpClient.put<MdfBoardManualMoveUpsertResponse>(
      apiRoutes.orders.statusBoardMdfManualMove(cardKind, normalizedCardId),
      { targetColumn },
    );
  },
  deleteMdfManualMove(
    cardKind: MdfBoardManualMoveCardKind,
    cardId: string,
  ): Promise<MdfBoardManualMoveDeleteResponse> {
    const normalizedCardId = assertMdfManualMoveIdentity(cardKind, cardId);
    return httpClient.delete<MdfBoardManualMoveDeleteResponse>(
      apiRoutes.orders.statusBoardMdfManualMove(cardKind, normalizedCardId),
    );
  },
};

function assertMdfManualMoveIdentity(
  cardKind: MdfBoardManualMoveCardKind,
  cardId: string,
): string {
  if (!['packet', 'bazisCutSet', 'bath', 'order'].includes(cardKind)) {
    throw new Error('Invalid cardKind');
  }
  const normalizedCardId = cardId.trim();
  if (!/^[A-Za-z0-9._:-]{1,240}$/.test(normalizedCardId)) {
    throw new Error('Invalid cardId');
  }
  return normalizedCardId;
}
