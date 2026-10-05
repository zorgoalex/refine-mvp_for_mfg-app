import { Injectable, Logger } from '@nestjs/common';
import type { OnecDocKind } from '../domain/onec-document-normalizer';

/**
 * Проход загрузчика изменил документы 1С (план 2026-09-30-onec-consumption-documents-plan.md, §3.3): созданные,
 * изменённые и удалённые при смене вида. Публикуется после завершения прохода — каждый документ уже закоммичен своей
 * транзакцией; незакоммиченные (упавшие) документы в сигнал не входят.
 */
export interface OnecDocumentsLoaded {
  sourceId: number;
  entityCode: string;
  docKinds: OnecDocKind[];
  documentIds: number[];
  requestId: string;
  correlationId: string;
}

type Listener = (event: OnecDocumentsLoaded) => Promise<void> | void;

/**
 * In-process сигнал для потребителей слоя документов (проекция склада). Доставка best effort: потерянный сигнал
 * (рестарт между commit и публикацией) покрывает периодический проход подписчика.
 */
@Injectable()
export class OnecDocumentsEvents {
  private readonly logger = new Logger(OnecDocumentsEvents.name);
  private readonly listeners = new Set<Listener>();

  onDocumentsLoaded(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitDocumentsLoaded(event: OnecDocumentsLoaded): void {
    for (const listener of this.listeners) {
      void Promise.resolve()
        .then(() => listener(event))
        .catch((error: unknown) => this.logger.error(`documents listener failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}
