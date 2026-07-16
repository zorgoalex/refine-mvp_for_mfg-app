import type {
  BazisOrderDraftResponse,
  CreateOrderFromDraftNode,
} from '../../api/types/bazisApi.types';
import type { OrderDetail } from '../../types/orders';
import { calculateOrderDetailArea } from '../../utils/orderArea';

export interface BazisDraftFormSeed {
  header: {
    clientId: number | null;
    projectId: number;
  };
  details: Array<Omit<OrderDetail, 'temp_id'>>;
  meta: {
    revisionId: number;
    clientId: number | null;
  };
}

export function draftToFormSeed(draft: BazisOrderDraftResponse): BazisDraftFormSeed {
  return {
    header: {
      clientId: draft.clientId ?? null,
      projectId: draft.projectId,
    },
    details: draft.details.map((detail, index) => ({
      bazisNodeId: detail.bazisNodeId,
      detail_number: index + 1,
      detail_name: detail.detailName,
      height: detail.height,
      width: detail.width,
      quantity: detail.quantity,
      area: calculateOrderDetailArea(detail.height, detail.width, detail.quantity),
      material_id: null,
      sheet_material_type_id: detail.sheetMaterialTypeId,
      film_id: detail.filmId,
      milling_type_id: detail.millingTypeId,
      edge_type_id: detail.edgeTypeId,
      milling_cost_per_sqm: 0,
      detail_cost: 0,
      priority: detail.priority,
      basis_project: detail.basisProject,
      basis_product: detail.basisProduct,
      basis_designation: detail.basisDesignation,
      basis_data: detail.basisData,
      doweling: detail.doweling === true,
      delete_flag: false,
    })),
    meta: {
      revisionId: draft.revisionId,
      clientId: draft.clientId ?? null,
    },
  };
}

export function collectProvenanceNodes<T extends { bazisNodeId?: number | null }>(
  rows: T[],
  clientKeyOf: (row: T) => string | undefined,
): CreateOrderFromDraftNode[] {
  const seenBazisNodeIds = new Set<number>();
  const nodes: CreateOrderFromDraftNode[] = [];

  rows.forEach((row) => {
    const bazisNodeId = row.bazisNodeId;
    if (!Number.isInteger(bazisNodeId) || (bazisNodeId ?? 0) <= 0) {
      return;
    }

    const clientKey = clientKeyOf(row);
    if (!clientKey) {
      return;
    }

    if (seenBazisNodeIds.has(bazisNodeId)) {
      console.warn(
        '[bazisOrderDraft] Duplicate bazisNodeId in order details, keeping first occurrence',
        bazisNodeId,
      );
      return;
    }

    seenBazisNodeIds.add(bazisNodeId);
    nodes.push({ clientKey, bazisNodeId });
  });

  return nodes;
}

/** Подсказка следующего номера заказа для draft-first формы: MAX числовых имён
 * последних заказов + 1 (паттерн CreateOrderModal). Сервер всё равно финально
 * гейтит уникальность (409 ORDER_NAME_DUPLICATE с точным suggested). */
export function buildNextOrderNameFromList(orderNames: ReadonlyArray<string>): string | null {
  const numbers = orderNames
    .map((name) => name.trim())
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
  if (numbers.length === 0) {
    return null;
  }
  return String(Math.max(...numbers) + 1);
}
