import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import type { TransactionClient } from '../../../database/database.types';
import {
  ORDER_REALTIME_DOMAINS,
  type AppendOrderRealtimeEventInput,
  type OrderRealtimeDomain,
  type OrderRealtimeEventRecord,
} from '../application/order-realtime.types';

interface EventRow extends QueryResultRow {
  order_id: string | number;
  commit_sequence: string | number;
  detail_status_revision: string | number | null;
  cut_refs_revision: string | number | null;
  domains: string[];
  detail_ids: Array<string | number> | null;
  occurred_at: Date | string;
}

interface StreamRow extends QueryResultRow {
  order_id: string | number;
  commit_sequence: string | number;
  detail_status_revision: string | number;
  cut_refs_revision: string | number;
}

@Injectable()
export class PgOrderRealtimeWriter {
  async lockOrderStreams(tx: TransactionClient, orderIds: readonly number[]): Promise<void> {
    const sorted = normalizeIds(orderIds);
    if (sorted.length === 0) return;

    await tx.query(
      `
      INSERT INTO order_realtime_stream (order_id)
      SELECT unnest($1::bigint[])
      ON CONFLICT (order_id) DO NOTHING
      `,
      [sorted],
    );
    await tx.query(
      `
      SELECT order_id
      FROM order_realtime_stream
      WHERE order_id = ANY($1::bigint[])
      ORDER BY order_id
      FOR UPDATE
      `,
      [sorted],
    );
  }

  async appendLocked(
    tx: TransactionClient,
    input: AppendOrderRealtimeEventInput,
  ): Promise<OrderRealtimeEventRecord> {
    assertPositiveId(input.orderId, 'orderId');
    const domains = normalizeDomains(input.domains);
    const detailIds = input.detailIds === null ? null : normalizeIds(input.detailIds ?? []);
    const sourceType = normalizeSource(input.sourceType, 'sourceType');
    const sourceKey = normalizeSource(input.sourceKey, 'sourceKey');

    const existing = await tx.query<EventRow>(
      `
      SELECT order_id, commit_sequence, detail_status_revision, cut_refs_revision,
             domains, detail_ids, occurred_at
      FROM realtime_event_log
      WHERE order_id = $1 AND source_key = $2
      `,
      [input.orderId, sourceKey],
    );
    if (existing.rows[0]) return mapEvent(existing.rows[0]);

    const updated = await tx.query<StreamRow>(
      `
      UPDATE order_realtime_stream
      SET commit_sequence = commit_sequence + 1,
          detail_status_revision = detail_status_revision
            + CASE WHEN 'detail_status' = ANY($2::text[]) THEN 1 ELSE 0 END,
          cut_refs_revision = cut_refs_revision
            + CASE WHEN 'cut_refs' = ANY($2::text[]) THEN 1 ELSE 0 END,
          updated_at = now()
      WHERE order_id = $1
      RETURNING order_id, commit_sequence, detail_status_revision, cut_refs_revision
      `,
      [input.orderId, domains],
    );
    const stream = updated.rows[0];
    if (!stream) throw new Error(`Order realtime stream ${input.orderId} is not locked`);

    const detailStatusRevision = domains.includes('detail_status')
      ? Number(stream.detail_status_revision)
      : null;
    const cutRefsRevision = domains.includes('cut_refs')
      ? Number(stream.cut_refs_revision)
      : null;
    const inserted = await tx.query<EventRow>(
      `
      INSERT INTO realtime_event_log (
        order_id, commit_sequence, detail_status_revision, cut_refs_revision,
        domains, detail_ids, schema_version, source_type, source_key, occurred_at
      )
      VALUES ($1, $2, $3, $4, $5::text[], $6::bigint[], 1, $7, $8, $9)
      RETURNING order_id, commit_sequence, detail_status_revision, cut_refs_revision,
                domains, detail_ids, occurred_at
      `,
      [
        input.orderId,
        Number(stream.commit_sequence),
        detailStatusRevision,
        cutRefsRevision,
        domains,
        detailIds,
        sourceType,
        sourceKey,
        input.occurredAt ?? new Date(),
      ],
    );
    await tx.query(`SELECT pg_notify('erp_realtime', $1)`, [`${input.orderId}:wake`]);
    return mapEvent(inserted.rows[0]);
  }
}

function normalizeDomains(values: readonly OrderRealtimeDomain[]): OrderRealtimeDomain[] {
  const allowed = new Set<OrderRealtimeDomain>(ORDER_REALTIME_DOMAINS);
  const domains = [...new Set(values)].sort() as OrderRealtimeDomain[];
  if (domains.length === 0 || domains.some((domain) => !allowed.has(domain))) {
    throw new Error('At least one valid realtime domain is required');
  }
  return domains;
}

function normalizeIds(values: readonly number[]): number[] {
  const ids = [...new Set(values)];
  ids.forEach((id) => assertPositiveId(id, 'id'));
  return ids.sort((left, right) => left - right);
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function normalizeSource(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new Error(`${label} is invalid`);
  return normalized;
}

function mapEvent(row: EventRow | undefined): OrderRealtimeEventRecord {
  if (!row) throw new Error('Realtime event insert returned no row');
  return {
    orderId: Number(row.order_id),
    commitSequence: Number(row.commit_sequence),
    detailStatusRevision: row.detail_status_revision === null ? null : Number(row.detail_status_revision),
    cutRefsRevision: row.cut_refs_revision === null ? null : Number(row.cut_refs_revision),
    domains: row.domains as OrderRealtimeDomain[],
    detailIds: row.detail_ids?.map(Number) ?? null,
    occurredAt: new Date(row.occurred_at).toISOString(),
  };
}
