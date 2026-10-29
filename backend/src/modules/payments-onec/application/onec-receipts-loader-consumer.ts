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
import { INCOMING_KINDS, REFUND_KINDS } from '../domain/onec-receipts';
import { detectOnecMatchTransitions, erpOrdersOfOnecOrders, lockOnecOrderRefs, lockOrderCandidates } from './onec-match-transitions';

/**
 * 1C receipts matching as a consumer of the 1C document loader (plan 2026-10-04-onec-incoming-payments §6, R1-8, R3-3).
 * Registered always, whatever the flags: a line with any match record (also a removed one — history) is never
 * deleted physically, it stays with its «removed in 1C» mark and an active match shows `changed`. Changes of
 * amount, order or date are applied as in 1C (no conflict); the drift is seen as `changed`, and a new drift writes
 * `payment.onec_review_required`. Locks only its own match records, never orders or payments.
 */
@Injectable()
export class OnecReceiptsLoaderConsumer implements OnecDocumentConsumer, OnModuleInit, OnModuleDestroy {
  readonly name = 'payments-onec';
  readonly docKinds = [...INCOMING_KINDS, 'customer_order'] as const;
  private unregister: (() => void) | null = null;

  constructor(@Inject(OnecDocumentConsumers) private readonly consumers: OnecDocumentConsumers) {}

  onModuleInit(): void {
    this.unregister = this.consumers.register(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  async guardLineChanges(
    _tx: DatabaseClient,
    _doc: LoadedDocumentView,
    _changes: readonly DocumentLineChange[],
  ): Promise<Array<{ lineNo: number; code: LineConflictCode }>> {
    // The 1C value always applies; a matched line that changed or disappeared becomes `changed` (manual review).
    return [];
  }

  async referencedLineIds(tx: DatabaseClient, lineIds: readonly number[]): Promise<Set<number>> {
    if (lineIds.length === 0) return new Set();
    const { rows } = await tx.query<{ line_id: string }>(
      `SELECT DISTINCT onec_document_line_id AS line_id FROM payment_onec_matches WHERE onec_document_line_id = ANY($1::bigint[])`,
      [lineIds],
    );
    return new Set(rows.map((row) => Number(row.line_id)));
  }

  async afterDocumentLoaded(tx: DatabaseClient, doc: LoadedDocumentView, _result: DocumentLoadResult): Promise<void> {
    // Refunds do not take part in the matched/changed condition nor in auto-match candidates (read time only).
    if ((REFUND_KINDS as readonly string[]).includes(doc.docKind)) return;
    // The load's own request/correlation: a review event is traced to the ingestion that caused it (code review R3-3).
    const context = { requestId: doc.requestId, correlationId: doc.correlationId, actorUserId: null, writer: 'onec_loader' };
    let refs: string[];
    if (doc.docKind === 'customer_order') {
      // Number or date of the 1C order changed → the series rule may resolve another ERP order.
      await detectOnecMatchTransitions(tx, { onecOrderRefKeys: [doc.onecRefKey] }, context);
      refs = [doc.onecRefKey];
    } else {
      await detectOnecMatchTransitions(tx, { onecDocumentIds: [doc.documentId] }, context);
      const { rows } = await tx.query<{ ref: string }>(
        `SELECT DISTINCT onec_order_ref_key::text AS ref FROM onec_document_lines
          WHERE onec_document_id = $1 AND onec_order_ref_key IS NOT NULL AND removed_in_onec_at IS NULL`,
        [doc.documentId],
      );
      refs = rows.map((row) => row.ref);
    }
    // LAST locks of the document transaction, after its match rows (detector above): the 1C orders of these lines —
    // serialised with a manual link/unlink of them, also when they resolve to no ERP order now (code review R3-1) —
    // then the ERP orders they resolve to — serialised with the auto-match of those orders. A 1C customer order load
    // may change what its receipts resolve to (number/date), like a manual link: exclusive, so it waits for a receipt
    // load of that order still in flight and the ERP order is resolved after it (code review R4-1).
    await lockOnecOrderRefs(tx, doc.sourceId, refs, doc.docKind === 'customer_order' ? 'exclusive' : 'shared');
    await lockOrderCandidates(tx, await erpOrdersOfOnecOrders(tx, doc.sourceId, refs), 'shared');
  }
}
