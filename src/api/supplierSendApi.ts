import { apiRoutes } from './apiRoutes';
import type { BroadcastRuntime } from './broadcastsApiTypes';
import { httpClient } from './httpClient';
import type { OrderSendResponse } from './orderSendApiTypes';

/** The recipient of a supplier request in WhatsApp: the supplier of the directory and his phones as masks. */
export interface SupplierSendMenu {
  /** The card sends are on, supplier requests are on and the backend makes such sends. */
  enabled: boolean;
  /** Why the request cannot be sent now (null = it can). */
  unavailableReason: 'disabled' | 'release' | 'not_linked' | 'no_phone' | 'supplier_inactive' | 'status' | null;
  supplier: { supplierId: number; name: string } | null;
  /** The primary phone first; `token` — «this row is this number», sent back with the choice. */
  contacts: Array<{ contactId: number; masked: string; isPrimary: boolean; token: string }>;
  requestVersion: number;
  queueLength: number;
  runtime: BroadcastRuntime;
}

/** The text of the window as it is, the version of the request it was built from and the chosen phone. */
export interface SupplierSendCommandInput {
  text: string;
  edited: boolean;
  templateId: number | null;
  templateVersion: number | null;
  textVersion: number;
  contactId: number;
  contactToken: string;
  idempotencyKey: string;
  /** Explicit repeat after the previous send of this text to this number ended unknown. */
  confirmAfterUnknown?: string;
}

export const supplierSendApi = {
  menu: (supplierRequestId: number, options?: { signal?: AbortSignal }) =>
    httpClient.get<SupplierSendMenu>(apiRoutes.procurement.supplierRequests.whatsappMenu(supplierRequestId), options),
  send: (supplierRequestId: number, body: SupplierSendCommandInput) =>
    httpClient.post<OrderSendResponse>(apiRoutes.procurement.supplierRequests.whatsappSends(supplierRequestId), body),
};
