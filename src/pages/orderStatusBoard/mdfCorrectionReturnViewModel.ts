import type {
  MdfCorrectionBlocker,
  MdfCorrectionPreviewResponse,
} from "../../api/mdfCorrectionApi";

export interface MdfCorrectionDetailRow {
  key: string;
  orderId: number;
  detailId: number;
  detailNumber: number | null;
  cardQuantity: number;
  wholeQuantity: number;
  beforeStatus: string | null;
  afterStatus: string | null;
  statusKept: boolean;
}

export interface MdfCorrectionOrderBucket {
  orderId: number;
  orderName: string;
  rows: MdfCorrectionDetailRow[];
}

export interface MdfCorrectionOrderConsequence {
  orderId: number;
  text: string;
}

export interface MdfCorrectionBathRow {
  key: string;
  bathId: string;
  beforeColumnTitle: string;
  afterColumnTitle: string | null;
  /** true when afterColumn cannot be known before the recalculation runs. */
  pendingRecalculation: boolean;
  cancelledLaminationQuantity: number;
  clearsManualPlacementOverride: boolean;
}

export interface MdfCorrectionReturnViewModel {
  ready: boolean;
  sourceLabel: string;
  targetColumnTitle: string;
  sourceAfterColumnTitle: string | null;
  sourceAfterPending: boolean;
  details: MdfCorrectionDetailRow[];
  detailsByOrder: MdfCorrectionOrderBucket[];
  orderConsequences: MdfCorrectionOrderConsequence[];
  baths: MdfCorrectionBathRow[];
  warnings: string[];
  blockerTexts: string[];
}

/** Russian explanation for one planMdfCorrection blocker code (see
 * backend mdf-correction-plan.ts for the authoritative code list). */
export function mdfCorrectionBlockerText(blocker: MdfCorrectionBlocker): string {
  const suffix = [
    blocker.sourceId ? `источник ${blocker.sourceId}` : null,
    blocker.allocationId ? `распределение ${blocker.allocationId}` : null,
    blocker.position ? `позиция ${blocker.position}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const withSuffix = (text: string) => (suffix ? `${text} (${suffix})` : text);
  switch (blocker.code) {
    case "INVALID_STAGE_RANKS":
      return "Не удалось определить производственные этапы реза и облицовки.";
    case "DUPLICATE_SOURCE":
      return withSuffix("Обнаружен дублирующийся источник производственных данных.");
    case "DUPLICATE_EVIDENCE":
      return withSuffix("Обнаружено дублирующееся производственное свидетельство.");
    case "TARGET_SOURCE_UNAVAILABLE":
      return withSuffix("Исходная карточка недоступна или ещё не подтверждена.");
    case "INVALID_QUANTITY":
      return withSuffix("Некорректное количество в связанных производственных данных.");
    case "INVALID_ALLOCATION":
      return withSuffix("Некорректное распределение по ваннам.");
    case "DEPENDENT_BATH_ATTRIBUTION_UNRESOLVED":
      return withSuffix("Не удалось однозначно определить принадлежность связанной ванны.");
    case "DEPENDENT_BATH_UNVERIFIED":
      return withSuffix("Связанная ванна не подтверждена.");
    case "PARTIAL_LAMINATION_ALLOCATION_MISMATCH":
      return withSuffix("Несоответствие частичного облицовочного распределения.");
    case "LAMINATION_PROOF_NOT_FOUND":
      return withSuffix("Не найдено доказательство облицовки для отмены.");
    case "ALLOCATION_EVIDENCE_UNVERIFIED":
      return withSuffix("Свидетельство распределения не подтверждено.");
    case "ALLOCATION_SUPPLY_EXCEEDED":
      return withSuffix("Превышен доступный объём производственного свидетельства.");
    case "AFFECTED_DEMAND_MISSING":
      return withSuffix("Не найдена затронутая деталь заказа.");
    case "INVALID_CURRENT_RANK":
      return withSuffix("Некорректный текущий производственный статус детали.");
    default:
      return withSuffix(`Возврат заблокирован (код: ${blocker.code}).`);
  }
}

export function buildMdfCorrectionReturnViewModel(
  preview: MdfCorrectionPreviewResponse,
  columnTitle: (key: string) => string
): MdfCorrectionReturnViewModel {
  const details: MdfCorrectionDetailRow[] = preview.details.map((d) => ({
    key: `${d.orderId}:${d.detailId}`,
    orderId: d.orderId,
    detailId: d.detailId,
    detailNumber: d.detailNumber,
    cardQuantity: d.cardQuantity,
    wholeQuantity: d.after.quantity,
    beforeStatus: d.beforeStatus,
    afterStatus: d.afterStatus,
    statusKept: d.statusKept,
  }));
  const byOrder = new Map<number, MdfCorrectionOrderBucket>();
  for (const row of details) {
    const orderName =
      preview.details.find((d) => d.orderId === row.orderId)?.orderName ??
      String(row.orderId);
    const bucket = byOrder.get(row.orderId) ?? {
      orderId: row.orderId,
      orderName,
      rows: [],
    };
    bucket.rows.push(row);
    byOrder.set(row.orderId, bucket);
  }
  const orderConsequences: MdfCorrectionOrderConsequence[] = preview.orders
    .filter((o) => o.before !== o.after)
    .map((o) => ({
      orderId: o.orderId,
      text: `Заказ «${o.orderName}»: ${o.before ?? "без статуса"} → ${
        o.after ?? "без статуса"
      }`,
    }));
  const baths: MdfCorrectionBathRow[] = preview.affectedBaths.map((b) => ({
    key: b.source.id,
    bathId: b.source.id,
    beforeColumnTitle: b.beforeColumn ? columnTitle(b.beforeColumn) : "—",
    afterColumnTitle: b.afterColumn ? columnTitle(b.afterColumn) : null,
    pendingRecalculation: b.afterIssues.length > 0,
    cancelledLaminationQuantity: b.cancelledLaminationQuantity,
    clearsManualPlacementOverride: b.clearsManualPlacementOverride,
  }));
  return {
    ready: preview.status === "ready",
    sourceLabel: preview.source.label,
    targetColumnTitle: columnTitle(preview.targetColumn),
    sourceAfterColumnTitle: preview.sourceAfter.afterColumn
      ? columnTitle(preview.sourceAfter.afterColumn)
      : null,
    sourceAfterPending: preview.sourceAfter.afterIssues.length > 0,
    details,
    detailsByOrder: [...byOrder.values()],
    orderConsequences,
    baths,
    warnings: preview.warnings,
    blockerTexts: preview.blockers.map(mdfCorrectionBlockerText),
  };
}
