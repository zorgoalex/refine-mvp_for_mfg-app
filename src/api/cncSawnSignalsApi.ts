import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  CncSawnApplyConfirmItem,
  CncSawnApplyConfirmResponse,
  CncSawnApplyPreviewResponse,
  CncSawnSignalSettings,
  CncSawnSignalsQuery,
  CncSawnSignalsResponse,
} from './types/cncSawnSignals.types';

export function createCncSawnIdempotencyKey(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `sawn-${random}`;
}

export const cncSawnSignalsApi = {
  list(query: CncSawnSignalsQuery = {}): Promise<CncSawnSignalsResponse> {
    return httpClient.get<CncSawnSignalsResponse>(withQuery(apiRoutes.cncTelegram.sawnSignals, query));
  },
  settings(): Promise<CncSawnSignalSettings> {
    return httpClient.get<CncSawnSignalSettings>(apiRoutes.cncTelegram.sawnSignalSettings);
  },
  setApplyToPacket(
    applyToPacket: boolean,
    idempotencyKey = createCncSawnIdempotencyKey(),
  ): Promise<CncSawnSignalSettings> {
    return httpClient.put<CncSawnSignalSettings>(apiRoutes.cncTelegram.sawnSignalSettings, {
      applyToPacket,
      idempotencyKey,
    });
  },
  applyPreview(packetSignalIds?: number[]): Promise<CncSawnApplyPreviewResponse> {
    return httpClient.post<CncSawnApplyPreviewResponse>(
      apiRoutes.cncTelegram.sawnSignalsApplyPreview,
      packetSignalIds && packetSignalIds.length > 0 ? { packetSignalIds } : {},
    );
  },
  applyConfirm(
    items: CncSawnApplyConfirmItem[],
    idempotencyKey = createCncSawnIdempotencyKey(),
  ): Promise<CncSawnApplyConfirmResponse> {
    return httpClient.post<CncSawnApplyConfirmResponse>(apiRoutes.cncTelegram.sawnSignalsApplyConfirm, {
      items,
      idempotencyKey,
    });
  },
};
