import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import type { SheetPlacementsJson } from '../../cut/application/cut-freecut-mapping';
import { buildSheetSvg } from '../../cut/render/sheet-svg';
import type { CncTelegramCutLayoutDto, CncTelegramStructuredIngestDto } from '../dto/cnc-telegram.dto';

type EvidenceSource = 'ingest' | 'authoritative_replay';
type ProjectionSource = 'ingest' | 'backfill';

export interface TelegramLabelMutationContext {
  actorUserId: string | number;
  actorUsername?: string | null;
  actorRole?: string | null;
  requestId: string;
}

interface PacketProjectionRow extends QueryResultRow {
  packet_id: string;
  source_version: string | number;
  payload_hash: string;
  source_chat_id: string;
  source_message_id: string | number | null;
  source_created_at: Date | string | null;
  source_updated_at: Date | string | null;
  cut_layout_json: unknown;
}

interface EvidenceHeaderRow extends QueryResultRow {
  payload_hash: string;
  evidence_set_digest: string;
  item_count: string | number;
}

interface EvidenceRow extends QueryResultRow {
  payload_hash: string;
  source_item_key: string;
  order_name: string;
  detail_number: string | number | null;
  width_mm: string | number | null;
  height_mm: string | number | null;
  quantity: string | number;
  source: 'vector' | 'ocr' | 'gcode' | 'manual';
  match_order_id: string | number | null;
  match_detail_id: string | number | null;
  match_status: 'unmatched' | 'matched' | 'conflict' | 'needs_review';
}

interface ActiveDetailRow extends QueryResultRow {
  detail_id: string | number;
  order_id: string | number;
  width: string | number | null;
  height: string | number | null;
  quantity: string | number;
}

export async function persistTelegramItemEvidence(
  tx: TransactionClient,
  input: {
    packetId: string;
    sourceVersion: number;
    payloadHash: string;
    dto: CncTelegramStructuredIngestDto;
    source: EvidenceSource;
    context: TelegramLabelMutationContext;
  },
): Promise<{ inserted: boolean; evidenceSetDigest: string }> {
  const canonicalItems = input.dto.items
    .map((item) => ({
      sourceItemKey: item.sourceItemKey,
      orderName: item.orderName,
      detailNumber: item.detailNumber ?? null,
      widthMm: item.widthMm ?? null,
      heightMm: item.heightMm ?? null,
      quantity: item.quantity,
      source: item.source,
      confidence: item.confidence,
      matchOrderId: item.matchOrderId ?? null,
      matchDetailId: item.matchDetailId ?? null,
      matchStatus: item.matchStatus ?? 'unmatched',
      reviewNote: normalizeOptional(item.reviewNote),
    }))
    .sort((a, b) => a.sourceItemKey.localeCompare(b.sourceItemKey));
  const evidenceSetDigest = digest(canonicalItems);
  const existing = await tx.query<EvidenceHeaderRow>(
    `SELECT payload_hash, evidence_set_digest, item_count
     FROM cnc_telegram_packet_evidence_set
     WHERE packet_id=$1::uuid AND source_version=$2`,
    [input.packetId, input.sourceVersion],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (
      row.payload_hash !== input.payloadHash
      || row.evidence_set_digest !== evidenceSetDigest
      || Number(row.item_count) !== canonicalItems.length
    ) {
      throw new ApiError(409, 'CNC_TELEGRAM_EVIDENCE_CONFLICT', 'Telegram item evidence conflicts with immutable replay', {
        packetId: input.packetId,
        sourceVersion: input.sourceVersion,
      });
    }
    return { inserted: false, evidenceSetDigest };
  }

  await tx.query(
    `INSERT INTO cnc_telegram_packet_evidence_set
       (packet_id, source_version, payload_hash, evidence_set_digest, item_count,
        created_by, request_id, source)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.packetId,
      input.sourceVersion,
      input.payloadHash,
      evidenceSetDigest,
      canonicalItems.length,
      Number(input.context.actorUserId),
      input.context.requestId,
      input.source,
    ],
  );
  for (const item of canonicalItems) {
    await tx.query(
      `INSERT INTO cnc_telegram_packet_item_evidence
         (packet_id, source_version, payload_hash, source_item_key, order_name, detail_number,
          width_mm, height_mm, quantity, source, confidence, match_order_id, match_detail_id,
          match_status, review_note, item_digest)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        input.packetId,
        input.sourceVersion,
        input.payloadHash,
        item.sourceItemKey,
        item.orderName,
        item.detailNumber,
        item.widthMm,
        item.heightMm,
        item.quantity,
        item.source,
        item.confidence,
        item.matchOrderId,
        item.matchDetailId,
        item.matchStatus,
        item.reviewNote,
        digest(item),
      ],
    );
  }
  const auditId = await auditService.record(tx, {
    event: 'cnc_telegram.item_evidence_persisted',
    entityType: 'cnc_telegram_packet',
    entityId: input.packetId,
    actorUserId: Number(input.context.actorUserId),
    actorUsername: input.context.actorUsername ?? null,
    actorRole: input.context.actorRole ?? null,
    requestId: input.context.requestId,
    source: 'backend-cnc-telegram-command',
    before: null,
    after: { packetId: input.packetId, sourceVersion: input.sourceVersion, itemCount: canonicalItems.length },
    diff: { evidenceInserted: true },
    metadata: { payloadHash: input.payloadHash, evidenceSetDigest, evidenceSource: input.source },
    relatedEntities: [],
  });
  await insertOutbox(tx, {
    eventType: 'cnc_telegram.item_evidence_persisted',
    packetId: input.packetId,
    idempotencyKey: `cnc-telegram:evidence:${input.packetId}:${input.sourceVersion}:${evidenceSetDigest}`,
    payload: {
      packetId: input.packetId,
      sourceVersion: input.sourceVersion,
      payloadHash: input.payloadHash,
      evidenceSetDigest,
      itemCount: canonicalItems.length,
      auditId,
      requestId: input.context.requestId,
    },
  });
  return { inserted: true, evidenceSetDigest };
}

export async function projectTelegramLabelMap(
  tx: TransactionClient,
  input: {
    packetId: string;
    source: ProjectionSource;
    context: TelegramLabelMutationContext;
  },
): Promise<{ projected: boolean; reason?: string; sheetMapId?: number }> {
  const packetResult = await tx.query<PacketProjectionRow>(
    `SELECT packet_id, source_version, payload_hash, source_chat_id, source_message_id,
            source_created_at, source_updated_at, cut_layout_json
     FROM cnc_telegram_packets WHERE packet_id=$1::uuid FOR UPDATE`,
    [input.packetId],
  );
  const packet = packetResult.rows[0];
  if (!packet) return { projected: false, reason: 'packet_not_found' };
  const sourceVersion = Number(packet.source_version);
  const existing = await tx.query<{ telegram_label_sheet_map_id: string | number }>(
    `SELECT telegram_label_sheet_map_id FROM cnc_telegram_label_sheet_map
     WHERE packet_id=$1::uuid AND source_version=$2`,
    [input.packetId, sourceVersion],
  );
  if (existing.rows[0]) {
    return { projected: false, reason: 'already_projected', sheetMapId: Number(existing.rows[0].telegram_label_sheet_map_id) };
  }
  const layout = parseValidLayout(packet.cut_layout_json);
  if (!layout?.sheet || layout.items.length === 0) return { projected: false, reason: 'no_valid_layout' };
  if (!layout.items.every((item) => geometryInsideSheet(item, layout.sheet!.widthMm, layout.sheet!.heightMm))) {
    return { projected: false, reason: 'invalid_geometry' };
  }

  const headerResult = await tx.query<EvidenceHeaderRow>(
    `SELECT payload_hash, evidence_set_digest, item_count
     FROM cnc_telegram_packet_evidence_set
     WHERE packet_id=$1::uuid AND source_version=$2`,
    [input.packetId, sourceVersion],
  );
  const header = headerResult.rows[0];
  if (!header || header.payload_hash !== packet.payload_hash) return { projected: false, reason: 'missing_evidence' };
  const evidenceResult = await tx.query<EvidenceRow>(
    `SELECT payload_hash, source_item_key, order_name, detail_number, width_mm, height_mm, quantity,
            source, match_order_id, match_detail_id, match_status
     FROM cnc_telegram_packet_item_evidence
     WHERE packet_id=$1::uuid AND source_version=$2
     ORDER BY source_item_key`,
    [input.packetId, sourceVersion],
  );
  if (
    evidenceResult.rows.length !== Number(header.item_count)
    || evidenceResult.rows.some((row) => row.payload_hash !== packet.payload_hash)
  ) return { projected: false, reason: 'incomplete_evidence' };

  const layoutGroups = groupBy(layout.items, (item) => layoutIdentityKey(
    item.orderName,
    item.detailNumber,
    item.widthMm,
    item.heightMm,
  ));
  const evidenceMatches = new Map<string, EvidenceRow[]>();
  const evidenceUseCounts = new Map<string, number>();
  for (const [key, items] of layoutGroups) {
    const sample = items[0];
    const matches = evidenceResult.rows.filter((evidence) => telegramEvidenceMatchesLayoutItem(evidence, sample));
    evidenceMatches.set(key, matches);
    for (const evidence of matches) {
      evidenceUseCounts.set(evidence.source_item_key, (evidenceUseCounts.get(evidence.source_item_key) ?? 0) + 1);
    }
  }
  const rawCandidates: Array<{
    evidence: EvidenceRow;
    items: CncTelegramCutLayoutDto['items'];
    orderId: number;
    detailId: number;
  }> = [];
  for (const [key, items] of layoutGroups) {
    const evidence = evidenceMatches.get(key) ?? [];
    if (evidence.length !== 1) continue;
    const row = evidence[0];
    if (evidenceUseCounts.get(row.source_item_key) !== 1) continue;
    const orderId = nullableNumber(row.match_order_id);
    const detailId = nullableNumber(row.match_detail_id);
    if (row.match_status !== 'matched' || orderId === null || detailId === null || Number(row.quantity) !== items.length) continue;
    rawCandidates.push({ evidence: row, items, orderId, detailId });
  }
  const duplicateDetailIds = new Set<number>();
  const candidateCounts = new Map<number, number>();
  for (const candidate of rawCandidates) {
    const count = (candidateCounts.get(candidate.detailId) ?? 0) + 1;
    candidateCounts.set(candidate.detailId, count);
    if (count > 1) duplicateDetailIds.add(candidate.detailId);
  }
  const candidates = rawCandidates.filter((candidate) => !duplicateDetailIds.has(candidate.detailId));
  if (candidates.length === 0) return { projected: false, reason: 'no_safe_matches' };

  const details = await loadActiveDetails(tx, candidates.map((candidate) => candidate.detailId));
  const safeCandidates = candidates.filter((candidate) => {
    const detail = details.get(candidate.detailId);
    const sourceWidth = nullableNumber(candidate.evidence.width_mm);
    const sourceHeight = nullableNumber(candidate.evidence.height_mm);
    if (!detail || detail.orderId !== candidate.orderId || sourceWidth === null || sourceHeight === null) return false;
    const tolerance = candidate.evidence.source === 'ocr' ? 3 : 0.01;
    return candidate.items.length <= detail.quantity
      && rotationAwareDimensionsMatch(sourceWidth, sourceHeight, detail.width, detail.height, tolerance);
  });
  if (safeCandidates.length === 0) return { projected: false, reason: 'stale_matches' };

  const sheet: SheetPlacementsJson = {
    trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
    sheet_width_mm: layout.sheet.widthMm,
    sheet_height_mm: layout.sheet.heightMm,
    pieces: layout.items.map((item, index) => ({
      item_id: `telegram-${index + 1}`,
      instance: 1,
      x_mm: item.xMm,
      y_mm: item.yMm,
      width_mm: item.placedWidthMm,
      height_mm: item.placedHeightMm,
      rotated: item.rotated,
    })),
  };
  const baseSvg = buildSheetSvg({ sheet, labelFor: () => '', showLabels: false });
  const layoutDigest = digest(layout);
  const totalSafePlacements = safeCandidates.reduce((sum, candidate) => sum + candidate.items.length, 0);
  const inserted = await tx.query<{ telegram_label_sheet_map_id: string | number }>(
    `INSERT INTO cnc_telegram_label_sheet_map
       (packet_id, source_version, payload_hash, evidence_set_digest, layout_digest,
        sheet_width_mm, sheet_height_mm, base_svg, source_chat_id, source_message_id,
        source_created_at, source_updated_at, total_contour_count, safe_placement_count,
        created_by, request_id, projection_source)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING telegram_label_sheet_map_id`,
    [
      input.packetId,
      sourceVersion,
      packet.payload_hash,
      header.evidence_set_digest,
      layoutDigest,
      layout.sheet.widthMm,
      layout.sheet.heightMm,
      baseSvg,
      packet.source_chat_id,
      packet.source_message_id,
      packet.source_created_at,
      packet.source_updated_at,
      layout.items.length,
      totalSafePlacements,
      Number(input.context.actorUserId),
      input.context.requestId,
      input.source,
    ],
  );
  const sheetMapId = Number(inserted.rows[0].telegram_label_sheet_map_id);
  const instanceByDetail = new Map<number, number>();
  for (const candidate of safeCandidates.sort((a, b) => a.detailId - b.detailId)) {
    for (const item of candidate.items) {
      const instance = (instanceByDetail.get(candidate.detailId) ?? 0) + 1;
      instanceByDetail.set(candidate.detailId, instance);
      await tx.query(
        `INSERT INTO cnc_telegram_label_placement
           (telegram_label_sheet_map_id, order_id, order_detail_id, instance, source_item_key,
            source_width_mm, source_height_mm, source_type, tolerance_mm,
            x_mm, y_mm, width_mm, height_mm, rotated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          sheetMapId,
          candidate.orderId,
          candidate.detailId,
          instance,
          candidate.evidence.source_item_key,
          candidate.evidence.width_mm,
          candidate.evidence.height_mm,
          candidate.evidence.source,
          candidate.evidence.source === 'ocr' ? 3 : 0.01,
          item.xMm,
          item.yMm,
          item.placedWidthMm,
          item.placedHeightMm,
          item.rotated,
        ],
      );
    }
  }
  const auditId = await auditService.record(tx, {
    event: 'cnc_telegram.label_map_projected',
    entityType: 'cnc_telegram_packet',
    entityId: input.packetId,
    actorUserId: Number(input.context.actorUserId),
    actorUsername: input.context.actorUsername ?? null,
    actorRole: input.context.actorRole ?? null,
    requestId: input.context.requestId,
    source: 'backend-cnc-telegram-command',
    before: null,
    after: { packetId: input.packetId, sourceVersion, sheetMapId, safePlacementCount: totalSafePlacements },
    diff: { labelMapProjected: true },
    metadata: {
      payloadHash: packet.payload_hash,
      evidenceSetDigest: header.evidence_set_digest,
      layoutDigest,
      totalContourCount: layout.items.length,
      projectionSource: input.source,
    },
    relatedEntities: [
      ...safeCandidates.map((candidate) => ({ entityType: 'order_detail', entityId: candidate.detailId })),
    ],
  });
  await insertOutbox(tx, {
    eventType: 'cnc_telegram.label_map_projected',
    packetId: input.packetId,
    idempotencyKey: `cnc-telegram:label-map:${input.packetId}:${sourceVersion}:${layoutDigest}`,
    payload: {
      packetId: input.packetId,
      sourceVersion,
      sheetMapId,
      layoutDigest,
      safePlacementCount: totalSafePlacements,
      totalContourCount: layout.items.length,
      auditId,
      requestId: input.context.requestId,
    },
  });
  return { projected: true, sheetMapId };
}

function parseValidLayout(value: unknown): CncTelegramCutLayoutDto | null {
  if (!value || typeof value !== 'object') return null;
  const layout = value as CncTelegramCutLayoutDto;
  return layout.status === 'valid' && Array.isArray(layout.items) ? layout : null;
}

function geometryInsideSheet(
  item: CncTelegramCutLayoutDto['items'][number],
  sheetWidth: number,
  sheetHeight: number,
): boolean {
  const values = [item.xMm, item.yMm, item.placedWidthMm, item.placedHeightMm, sheetWidth, sheetHeight];
  return values.every(Number.isFinite)
    && item.xMm >= 0
    && item.yMm >= 0
    && item.placedWidthMm > 0
    && item.placedHeightMm > 0
    && item.xMm + item.placedWidthMm <= sheetWidth + 0.01
    && item.yMm + item.placedHeightMm <= sheetHeight + 0.01;
}

async function loadActiveDetails(
  tx: TransactionClient,
  detailIds: number[],
): Promise<Map<number, { orderId: number; width: number; height: number; quantity: number }>> {
  const result = await tx.query<ActiveDetailRow>(
    `SELECT od.detail_id, od.order_id, od.width, od.height, od.quantity
     FROM order_details od
     JOIN orders o ON o.order_id=od.order_id AND o.delete_flag=false
     WHERE od.detail_id=ANY($1::bigint[]) AND od.delete_flag=false
       AND od.width IS NOT NULL AND od.height IS NOT NULL`,
    [[...new Set(detailIds)]],
  );
  return new Map(result.rows.map((row) => [Number(row.detail_id), {
    orderId: Number(row.order_id),
    width: Number(row.width),
    height: Number(row.height),
    quantity: Number(row.quantity),
  }]));
}

function layoutIdentityKey(orderName: string, detailNumber: number | null, width: number | null, height: number | null): string {
  const dims = width === null || height === null
    ? 'missing'
    : [round2(width), round2(height)].sort((a, b) => a - b).join('x');
  return `${orderDetailIdentityKey(orderName, detailNumber)}|${dims}`;
}

export function telegramEvidenceMatchesLayoutItem(
  evidence: Pick<EvidenceRow, 'order_name' | 'detail_number' | 'width_mm' | 'height_mm' | 'source'>,
  item: Pick<CncTelegramCutLayoutDto['items'][number], 'orderName' | 'detailNumber' | 'widthMm' | 'heightMm'>,
): boolean {
  const evidenceWidth = nullableNumber(evidence.width_mm);
  const evidenceHeight = nullableNumber(evidence.height_mm);
  if (
    orderDetailIdentityKey(evidence.order_name, nullableNumber(evidence.detail_number))
      !== orderDetailIdentityKey(item.orderName, item.detailNumber)
    || evidenceWidth === null
    || evidenceHeight === null
    || item.widthMm === null
    || item.heightMm === null
  ) return false;
  return rotationAwareDimensionsMatch(
    evidenceWidth,
    evidenceHeight,
    item.widthMm,
    item.heightMm,
    evidence.source === 'ocr' ? 3 : 0.01,
  );
}

function orderDetailIdentityKey(orderName: string, detailNumber: number | null): string {
  return `${orderName.trim().toLocaleLowerCase('ru-RU')}|${detailNumber ?? 'null'}`;
}

function rotationAwareDimensionsMatch(
  leftWidth: number,
  leftHeight: number,
  rightWidth: number,
  rightHeight: number,
  tolerance: number,
): boolean {
  return (Math.abs(leftWidth - rightWidth) <= tolerance && Math.abs(leftHeight - rightHeight) <= tolerance)
    || (Math.abs(leftWidth - rightHeight) <= tolerance && Math.abs(leftHeight - rightWidth) <= tolerance);
}

function groupBy<T>(values: readonly T[], keyFor: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function nullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

async function insertOutbox(
  tx: TransactionClient,
  input: { eventType: string; packetId: string; payload: Record<string, unknown>; idempotencyKey: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key)
     VALUES ($1,'cnc_telegram_packet',$2,$3::jsonb,$4)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [input.eventType, input.packetId, JSON.stringify(input.payload), input.idempotencyKey],
  );
}
