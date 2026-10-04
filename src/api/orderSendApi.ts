import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  OrderSendClientContacts,
  OrderSendCommandInput,
  OrderSendMenu,
  OrderSendQueue,
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
  /** Phones of the order's client (masks) for the «Отправить заказ» menu. */
  clientContacts: (orderId: number) => httpClient.get<OrderSendClientContacts>(apiRoutes.orders.whatsappSendClientContacts(orderId)),
  queue: (history = false, page = 1) =>
    httpClient.get<OrderSendQueue>(`${apiRoutes.whatsapp.orderSend.queue}${history ? `?history=1&page=${page}` : ''}`),
  cancel: (sendId: string) => httpClient.post<OrderSendResponse>(apiRoutes.whatsapp.orderSend.cancel(sendId), {}),
};
