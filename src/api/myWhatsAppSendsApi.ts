import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';

/** A WhatsApp send the current user started himself (order card or calendar). */
export interface MyWhatsAppSend {
  kind: 'order_send' | 'calendar_send';
  id: string;
  title: string;
  state: string;
  active: boolean;
  /** Approximate start of the delivery while queued/sending; null when final. */
  estimatedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  cancelReason: string | null;
  orderId: number | null;
  targetDate: string | null;
}

export interface MyWhatsAppSendsResponse {
  serverTime: string;
  items: MyWhatsAppSend[];
}

export const myWhatsAppSendsApi = {
  /** `ids` — followed sends whose result is still due (returned whatever their age, own only). */
  list: (ids: readonly string[] = []) => httpClient.get<MyWhatsAppSendsResponse>(
    ids.length ? `${apiRoutes.whatsapp.mySends}?ids=${ids.slice(-50).map(encodeURIComponent).join(',')}` : apiRoutes.whatsapp.mySends),
};
