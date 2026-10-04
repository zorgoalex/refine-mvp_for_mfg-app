import type { DatabaseClient } from '../../../database/database.types';
import type { OnecUnitCode } from '../domain/onec-document-normalizer';

// Read-порт слоя документов 1С для проекции склада (план 2026-09-30-onec-consumption-documents-plan.md, §3.5).
// Только чтение; `client` — транзакция вызывающего. Сопоставление складов/плёнок делает потребитель.

/** Виды документов расхода (§3.2). */
export const CONSUMPTION_DOC_KINDS = ['sales_shipment', 'supplier_return', 'inventory_writeoff', 'inventory_transfer'] as const;
export type ConsumptionDocKind = (typeof CONSUMPTION_DOC_KINDS)[number];

export interface ConsumptionLineView {
  lineId: number;
  lineNo: number;
  /** Склад строки (у перемещения — склад-источник шапки). Нижний регистр; null — не указан в 1С. */
  warehouseRefKey: string | null;
  nomenclatureRefKey: string | null;
  /** NUMERIC(14,3) как строка. */
  quantity: string;
  unitCode: OnecUnitCode | null;
  unitIsPackage: boolean;
  isStockItem: boolean;
  removedInOnec: boolean;
  loadConflictCode: string | null;
}

export interface ConsumptionDocumentView {
  documentId: number;
  sourceId: number;
  onecRefKey: string;
  docKind: ConsumptionDocKind;
  number: string;
  /** Ревизия применённого состояния документа (растёт при каждом изменении). */
  revision: number;
  posted: boolean;
  deletedInOnec: boolean;
  missingInSource: boolean;
  /** YYYY-MM-DD. */
  docDate: string;
  /** Момент документа 1С (ISO 8601 с 'Z'); null — не заполнен (документ загружен до v2). */
  docAt: string | null;
  /** Склад шапки (нижний регистр). */
  warehouseRefKey: string | null;
  /** Склад-получатель перемещения (нижний регистр); у остальных видов null. */
  destinationWarehouseRefKey: string | null;
  lines: ConsumptionLineView[];
}

export interface ConsumptionCandidatesFilter {
  /** Источники; пусто — ни одного. */
  sourceIds: readonly number[];
  /** Виды; по умолчанию все виды расхода. */
  kinds?: readonly ConsumptionDocKind[];
  /** Только документы, у которых склад строки или получатель — один из ключей (нижний регистр). */
  warehouseRefKeys?: readonly string[];
  /** Только эти документы. */
  documentIds?: readonly number[];
}

export interface OnecDocumentsReaderPort {
  /**
   * Документы расхода с их строками — входы hash проекции. Без блокировок; порядок — по documentId.
   * Модуль выключен → ApiError 409 `ONEC_DOCUMENTS_UNAVAILABLE`.
   */
  consumptionCandidates(filter: ConsumptionCandidatesFilter, client?: DatabaseClient): Promise<ConsumptionDocumentView[]>;
  /**
   * Шапка документа `FOR SHARE` (загрузчик меняет документ под `FOR NO KEY UPDATE` шапки — ждёт commit
   * вызывающего) + строки. null — документа нет (удалён при смене вида → проекция считает его `gone`).
   * Документ не расхода → null. Модуль выключен → ApiError 409 `ONEC_DOCUMENTS_UNAVAILABLE`.
   */
  lockDocumentForProjection(documentId: number, client: DatabaseClient): Promise<ConsumptionDocumentView | null>;
}
