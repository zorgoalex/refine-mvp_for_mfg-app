import { ApiError } from '../../../common/errors/api-error';

// Порт чтения документов расхода 1С для проекции склада (план 2026-09-30-onec-consumption-documents-plan.md §3.5).
// Типы — из модуля onec-sync (владелец — сессия 1С); склад зависит только от интерфейса, реализация подключается
// в InventoryModule. Заглушки ниже — для тестов и как «модуль выключен».
import type { OnecDocumentsReaderPort } from '../../onec-sync/application/onec-documents-reader.types';

export {
  CONSUMPTION_DOC_KINDS, STOCK_RECEIPT_DOC_KINDS,
  type ConsumptionCandidatesFilter, type ConsumptionDocKind, type ConsumptionDocumentView, type ConsumptionLineView,
  type StockProjectionDocKind,
} from '../../onec-sync/application/onec-documents-reader.types';

export const ONEC_CONSUMPTION_READER = Symbol('ONEC_CONSUMPTION_READER');

export type OnecConsumptionReader = OnecDocumentsReaderPort;

/** Модуль документов 1С не подключён: как выключенный модуль (проход пропускается без алерта). */
export class UnavailableOnecConsumptionReader implements OnecConsumptionReader {
  async consumptionCandidates(): Promise<never[]> {
    throw new ApiError(409, 'ONEC_DOCUMENTS_UNAVAILABLE', 'Документы 1С недоступны');
  }

  async lockDocumentForProjection(): Promise<null> {
    throw new ApiError(409, 'ONEC_DOCUMENTS_UNAVAILABLE', 'Документы 1С недоступны');
  }
}

/** Сигнал загрузчика документов 1С после commit прохода (best effort; потеря покрывается часовым проходом). */
export const ONEC_DOCUMENTS_SIGNAL = Symbol('ONEC_DOCUMENTS_SIGNAL');

export interface OnecDocumentsLoaded {
  sourceId: number;
  entityCode: string;
  docKinds: readonly string[];
  documentIds: readonly number[];
  requestId: string;
  correlationId: string;
}

export interface OnecDocumentsSignal {
  onDocumentsLoaded(listener: (event: OnecDocumentsLoaded) => void): () => void;
}

/** Модуль документов 1С не подключён — сигналов нет. */
export class NoOnecDocumentsSignal implements OnecDocumentsSignal {
  onDocumentsLoaded(): () => void {
    return () => undefined;
  }
}
