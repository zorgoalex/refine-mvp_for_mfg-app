import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { DatabaseClient } from '../../../database/database.types';
import {
  OnecDocumentConsumers,
  type DocumentLineChange,
  type DocumentLoadResult,
  type LineConflictCode,
  type LoadedDocumentView,
  type OnecDocumentConsumer,
} from '../../onec-sync/application/onec-document-consumers';
import { recordResourceSuppliers } from '../adapters/pg-onec-documents-repository';
import type { OrderResourceKind } from './order-resource-demand.types';

/**
 * Закупки как потребитель загрузчика документов 1С (план 2026-09-30-onec-documents-loader-plan.md, Р1, согласовано с
 * сессией закупок). В транзакции загрузки только читает распределения строк документа (они меняются только под
 * блокировкой строки, которую держит загрузчик) и в конце пишет реестр поставщиков (R5-2); заказы и закупы не
 * блокирует. Автопривязка — отдельно, по outbox `onec.document_changed`.
 */
@Injectable()
export class OnecDocumentsProcurementConsumer implements OnecDocumentConsumer, OnModuleInit, OnModuleDestroy {
  readonly name = 'procurement';
  readonly docKinds = ['purchase_receipt', 'cash_outflow', 'bank_outflow'] as const;
  private unregister: (() => void) | null = null;

  constructor(@Inject(OnecDocumentConsumers) private readonly consumers: OnecDocumentConsumers) {}

  onModuleInit(): void {
    this.unregister = this.consumers.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async guardLineChanges(
    tx: DatabaseClient,
    _doc: LoadedDocumentView,
    changes: readonly DocumentLineChange[],
  ): Promise<Array<{ lineNo: number; code: LineConflictCode }>> {
    const lineIds = changes.flatMap((change) => (change.lineId === null ? [] : [change.lineId]));
    if (lineIds.length === 0) return [];
    const { rows } = await tx.query<{ line_id: string; quantity: string; amount: string }>(
      `SELECT onec_document_line_id::text AS line_id, COALESCE(sum(quantity), 0)::text AS quantity, COALESCE(sum(amount), 0)::text AS amount
         FROM order_resource_onec_allocations
        WHERE onec_document_line_id = ANY($1::bigint[]) AND removed_at IS NULL
        GROUP BY onec_document_line_id`,
      [lineIds],
    );
    const active = new Map(rows.map((row) => [Number(row.line_id), { quantity: Number(row.quantity), amount: Number(row.amount) }]));
    const conflicts: Array<{ lineNo: number; code: LineConflictCode }> = [];
    for (const change of changes) {
      const used = change.lineId === null ? undefined : active.get(change.lineId);
      if (!used || (used.quantity <= 0 && used.amount <= 0)) continue;
      if (change.kind === 'remove' || !change.after) { conflicts.push({ lineNo: change.lineNo, code: 'REMOVED_WITH_ALLOCATION' }); continue; }
      const before = change.before!;
      const after = change.after;
      if (after.isDocumentTotal) {
        // Оплата: лимит — сумма документа (строка-итог = СуммаДокумента).
        if (Number(after.amount ?? 0) + 1e-9 < used.amount) conflicts.push({ lineNo: change.lineNo, code: 'AMOUNT_BELOW_ALLOCATED' });
        continue;
      }
      if (before.sheetMaterialTypeId !== after.sheetMaterialTypeId || before.filmId !== after.filmId) {
        conflicts.push({ lineNo: change.lineNo, code: 'MATERIAL_CHANGED' });
      } else if (before.unitCode !== after.unitCode) {
        conflicts.push({ lineNo: change.lineNo, code: 'UNIT_CHANGED' });
      } else if (Number(after.quantity) + 1e-9 < used.quantity) {
        conflicts.push({ lineNo: change.lineNo, code: 'QUANTITY_BELOW_ALLOCATED' });
      }
    }
    return conflicts;
  }

  /** Любые распределения (включая снятые) — ссылка FK, физически удалить строку нельзя. */
  async referencedLineIds(tx: DatabaseClient, lineIds: readonly number[]): Promise<Set<number>> {
    if (lineIds.length === 0) return new Set();
    const { rows } = await tx.query<{ line_id: string }>(
      'SELECT DISTINCT onec_document_line_id::text AS line_id FROM order_resource_onec_allocations WHERE onec_document_line_id = ANY($1::bigint[])',
      [[...lineIds]],
    );
    return new Set(rows.map((row) => Number(row.line_id)));
  }

  /**
   * Реестр поставщиков (§3a, R2-4, R3-2): только проведённый, не удалённый приход; только применённые строки без
   * конфликта и не удалённые в 1С, с однозначно сопоставленным материалом; поставщик — из применённой шапки;
   * first_seen_at = дата документа.
   */
  async afterDocumentLoaded(tx: DatabaseClient, doc: LoadedDocumentView, result: DocumentLoadResult): Promise<void> {
    if (doc.docKind !== 'purchase_receipt' || !doc.posted || doc.deletedInOnec) return;
    const line = {
      doc_supplier_id: doc.supplierId,
      doc_counterparty_ref_key: doc.counterpartyRefKey,
      doc_counterparty_name: doc.counterpartyName,
      onec_document_id: doc.documentId,
    };
    const items: Array<{ kind: OrderResourceKind; refId: number; line: typeof line; firstSeenAt: string }> = [];
    for (const applied of result.appliedLines) {
      if (applied.isDocumentTotal) continue;
      if (applied.sheetMaterialTypeId !== null) items.push({ kind: 'sheet_material', refId: applied.sheetMaterialTypeId, line, firstSeenAt: doc.docDate });
      else if (applied.filmId !== null) items.push({ kind: 'film', refId: applied.filmId, line, firstSeenAt: doc.docDate });
    }
    if (items.length > 0) await recordResourceSuppliers(tx, items);
  }
}
