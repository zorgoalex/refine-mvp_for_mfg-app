import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  OrderSendCommandInput,
  OrderSendMenu,
  OrderSendResponse,
  OrderSendSettingsEnvelope,
  OrderSendSettingsInput,
  OrderSendView,
} from './orderSendApiTypes';

export const orderSendApi = {
  settings: () => httpClient.get<OrderSendSettingsEnvelope>(apiRoutes.whatsapp.orderSend.settings),
  updateSettings: (body: OrderSendSettingsInput) =>
    httpClient.put<OrderSendSettingsEnvelope>(apiRoutes.whatsapp.orderSend.settings, body),
  menu: () => httpClient.get<OrderSendMenu>(apiRoutes.whatsapp.orderSend.menu),
  send: (orderId: number, body: OrderSendCommandInput) =>
    httpClient.post<OrderSendResponse>(apiRoutes.orders.whatsappSends(orderId), body),
  list: (orderId: number) =>
    httpClient.get<{ sends: OrderSendView[] }>(apiRoutes.orders.whatsappSends(orderId)),
};
