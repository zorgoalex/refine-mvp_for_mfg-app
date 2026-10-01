import { Injectable } from '@nestjs/common';
import type { DatabaseClient } from '../../../database/database.types';
import type { OnecDocKind, OnecUnitCode } from '../domain/onec-document-normalizer';

// Порт потребителей загрузчика документов 1С (план 2026-09-30-onec-documents-loader-plan.md, Р1).
// Правила (согласованы с сессией закупок):
// - вызывается внутри транзакции документа после блокировок шапки и всех строк документа;
// - потребитель НЕ блокирует orders / order_resource_procurement (у команд обратный порядок — дедлок);
//   разрешено читать свои данные по строкам документа и в конце писать реестры по протоколу R5-2;
// - guard возвращает конфликты, а не бросает; исключение потребителя откатывает весь документ;
// - автопривязка и другие действия с заказами — только отдельной транзакцией по outbox-событию.

export type LineConflictCode =
  | 'QUANTITY_BELOW_ALLOCATED'
  | 'REMOVED_WITH_ALLOCATION'
  | 'MATERIAL_CHANGED'
  | 'UNIT_CHANGED'
  | 'AMOUNT_BELOW_ALLOCATED'
  /** Сменилась валюта документа при активных распределениях (суммы распределений — в прежней валюте). */
  | 'CURRENCY_CHANGED';

/** Состояние строки документа, как оно хранится в onec_document_lines. */
export interface DocumentLineState {
  lineNo: number;
  quantity: string;
  amount: string | null;
  unitCode: OnecUnitCode | null;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  isDocumentTotal: boolean;
}

/** Изменение строки, которое загрузчик собирается применить. lineId — null у новой строки. */
export interface DocumentLineChange {
  lineId: number | null;
  lineNo: number;
  kind: 'insert' | 'update' | 'remove';
  before: DocumentLineState | null;
  after: DocumentLineState | null;
}

/** Шапка документа в том состоянии, которое загрузчик применяет (или применил). */
export interface LoadedDocumentView {
  documentId: number;
  sourceId: number;
  docKind: OnecDocKind;
  onecRefKey: string;
  docDate: string;
  posted: boolean;
  deletedInOnec: boolean;
  supplierId: number | null;
  counterpartyRefKey: string | null;
  counterpartyName: string | null;
  amount: string | null;
  /** Валюта (ISO) — целевая при проверке, применённая после загрузки; null у документов без валюты. */
  currency: string | null;
  /** Применённое состояние шапки до этой загрузки; null — документ новый. */
  previous: { currency: string | null; amount: string | null } | null;
}

export interface AppliedDocumentLine extends DocumentLineState {
  lineId: number;
}

export interface DocumentLoadResult {
  /** Строки в согласованном состоянии: применены, без конфликта, не удалены в 1С. */
  appliedLines: AppliedDocumentLine[];
  conflictedLines: Array<{ lineId: number; lineNo: number; code: LineConflictCode }>;
  removedLines: Array<{ lineId: number; lineNo: number }>;
}

export interface OnecDocumentConsumer {
  /** Уникальное имя; порядок вызова — по имени. */
  readonly name: string;
  readonly docKinds: readonly OnecDocKind[];
  /** Конфликты изменений строк с данными потребителя (например, активными распределениями). */
  guardLineChanges(tx: DatabaseClient, doc: LoadedDocumentView, changes: readonly DocumentLineChange[]): Promise<Array<{ lineNo: number; code: LineConflictCode }>>;
  /** Строки, на которые у потребителя есть ссылки (любые, включая исторические) — их нельзя удалить физически. */
  referencedLineIds(tx: DatabaseClient, lineIds: readonly number[]): Promise<Set<number>>;
  /** Побочные записи потребителя после применения; только при изменении применённого состояния документа. */
  afterDocumentLoaded(tx: DatabaseClient, doc: LoadedDocumentView, result: DocumentLoadResult): Promise<void>;
}

/** Реестр потребителей. `onec-sync` не импортирует модули-потребители — они регистрируются сами. */
@Injectable()
export class OnecDocumentConsumers {
  private readonly consumers = new Map<string, OnecDocumentConsumer>();

  register(consumer: OnecDocumentConsumer): () => void {
    if (this.consumers.has(consumer.name)) throw new Error(`1C document consumer ${consumer.name} is already registered`);
    this.consumers.set(consumer.name, consumer);
    return () => this.consumers.delete(consumer.name);
  }

  /** Потребители вида документа в детерминированном порядке (по имени). */
  forKind(kind: OnecDocKind): OnecDocumentConsumer[] {
    return [...this.consumers.values()]
      .filter((consumer) => consumer.docKinds.includes(kind))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }
}
