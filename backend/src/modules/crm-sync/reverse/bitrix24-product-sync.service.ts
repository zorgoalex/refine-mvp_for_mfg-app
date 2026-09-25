import { createHash } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import type { Bitrix24ApiPort } from '../adapters/bitrix24-api-client';
import type { CrmSyncRuntimeConfigService } from '../http/crm-sync-runtime-config.service';
import type { PgBitrix24ReverseRepository } from './pg-bitrix24-reverse-repository';
import {
  moneyText,
  normalizeBitrixProductRow,
  type Bitrix24ProductRow,
  type Bitrix24ProductRowInvalid,
} from './bitrix24-product-rows';

const DEAL_ENTITY_TYPE_ID = 2;
const COHERENCE_ATTEMPTS = 2;

export type ProductSyncStatus = 'ready' | 'blocked' | 'unchanged' | 'skipped';

export interface ProductSyncResult {
  status: ProductSyncStatus;
  requestId: number | null;
  orderId: number | null;
  reason: string | null;
  blockedIds: string[];
}

interface NormalizedFetch {
  item: Record<string, unknown>;
  rows: Bitrix24ProductRow[];
  invalid: Bitrix24ProductRowInvalid[];
  rowsHash: string;
}

function normalizeRows(remoteRows: Array<Record<string, unknown>>): {
  rows: Bitrix24ProductRow[];
  invalid: Bitrix24ProductRowInvalid[];
  rowsHash: string;
} {
  const rows: Bitrix24ProductRow[] = [];
  const invalid: Bitrix24ProductRowInvalid[] = [];
  for (const raw of remoteRows) {
    const normalized = normalizeBitrixProductRow(raw);
    if ('row' in normalized) rows.push(normalized.row);
    else invalid.push(normalized.invalid);
  }
  // The list hash covers every remote row; invalid rows contribute a hash of
  // their identity+code so a fixed or changed invalid row still changes it.
  const hashes = [
    ...rows.map((row) => row.normalizedHash),
    ...invalid.map((row) =>
      createHash('sha256')
        .update(`invalid:${row.code}:${row.rowId}:${row.productId}`)
        .digest('hex')),
  ].sort();
  return {
    rows,
    invalid,
    rowsHash: createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),
  };
}

function dealRevisionMeta(item: Record<string, unknown>): string {
  // Deal revision is NOT a proven product-row revision (second-resolution
  // updates may not bump it), so coherence also requires the double row read
  // below; the meta still catches Deal edits made during the row fetch.
  return JSON.stringify([
    item.updatedTime ?? null,
    item.currencyId ?? null,
    item.opportunity ?? null,
  ]);
}

/**
 * Orchestrates one complete product-row refresh for a Deal. Coherence is
 * established by a bounded double read: the Deal item is fetched around the
 * row list, and the row list itself is fetched twice — both complete
 * normalized lists must hash-identical, otherwise a concurrent remote row
 * edit slipped between pages and the refresh retries/fails instead of
 * marking the request ready on a torn snapshot.
 */
export class Bitrix24ProductSyncService {
  constructor(
    private readonly repository: PgBitrix24ReverseRepository,
    private readonly bitrix: Bitrix24ApiPort,
    private readonly config: CrmSyncRuntimeConfigService,
  ) {}

  async syncDeal(input: {
    dealId: string;
    auditRequestId: string;
    eventId?: string;
    lockToken?: string;
  }): Promise<ProductSyncResult> {
    const [bitrix, reverse] = await Promise.all([
      this.config.getBitrix24(),
      this.config.getReverseSync(),
    ]);
    // Fail closed on the same runtime gate as the processor: no remote reads
    // or local writes when reverse sync is disabled or running dry-run.
    if (!reverse.enabled || reverse.dryRun) {
      throw new ApiError(
        503,
        'BITRIX24_REVERSE_SYNC_DISABLED',
        'Bitrix24 reverse synchronization is not active',
      );
    }
    // Local generation fence BEFORE any remote read: without an observed
    // request there is nothing safe to apply to, so skip the REST calls.
    const fence = await this.repository.getProductSyncFence(input.dealId);
    if (fence === null) {
      return { status: 'skipped', requestId: null, orderId: null, reason: null, blockedIds: [] };
    }
    let fetch: NormalizedFetch | null = null;
    for (let attempt = 0; attempt < COHERENCE_ATTEMPTS; attempt += 1) {
      const itemA = await this.bitrix.getCrmItem(DEAL_ENTITY_TYPE_ID, input.dealId);
      const rowsA = normalizeRows(
        await this.bitrix.listDealProductRows(input.dealId),
      );
      const itemB = await this.bitrix.getCrmItem(DEAL_ENTITY_TYPE_ID, input.dealId);
      if (dealRevisionMeta(itemA) !== dealRevisionMeta(itemB)) continue;
      const rowsB = normalizeRows(
        await this.bitrix.listDealProductRows(input.dealId),
      );
      if (rowsA.rowsHash !== rowsB.rowsHash) continue;
      fetch = { item: itemA, ...rowsA };
      break;
    }
    if (!fetch) {
      throw new ApiError(
        409,
        'BITRIX24_PRODUCT_SYNC_INCOHERENT',
        'Bitrix24 product rows changed during the read; retry the reconciliation',
      );
    }
    if (reverse.actorUserId === null) {
      throw new ApiError(
        503,
        'BITRIX24_PRODUCT_SYNC_FAILED',
        'Reverse-sync service actor is not configured',
      );
    }
    return this.repository.applyDealProductSnapshot({
      dealId: input.dealId,
      rows: fetch.rows,
      invalid: fetch.invalid,
      rowsHash: fetch.rowsHash,
      opportunity: moneyText(fetch.item.opportunity),
      expectedCurrencyId: bitrix.currencyId,
      currencyId: fetch.item.currencyId === null || fetch.item.currencyId === undefined
        ? null
        : String(fetch.item.currencyId),
      auditRequestId: input.auditRequestId,
      eventId: input.eventId,
      lockToken: input.lockToken,
      actorUserId: reverse.actorUserId,
      fence,
      remoteUpdatedAt:
        fetch.item.updatedTime === null || fetch.item.updatedTime === undefined
          ? null
          : String(fetch.item.updatedTime),
    });
  }

  /** Reconcile products for the active request linked to an ERP order. */
  async syncForOrderId(
    orderId: number,
    auditRequestId: string,
  ): Promise<ProductSyncResult> {
    const request = await this.repository.findActiveRequestByOrderId(orderId);
    if (!request) {
      return { status: 'skipped', requestId: null, orderId, reason: null, blockedIds: [] };
    }
    return this.syncDeal({ dealId: request.dealId, auditRequestId });
  }
}
