import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
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
};

