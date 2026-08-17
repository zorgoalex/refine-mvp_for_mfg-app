import type { OrderDetail } from '../../types/orders';
import type { OrderRefreshResponse } from '../../api/types/orderApi.types';

const DOWELING_WORD_RE = /(^|[^\p{L}\p{N}_])присадка(?=$|[^\p{L}\p{N}_])/iu;

export function noteRequiresDoweling(note: unknown): boolean {
  return typeof note === 'string' && DOWELING_WORD_RE.test(note);
}

export function mergeOrderRefreshDetails(
  currentDetails: readonly OrderDetail[],
  serverDetails: readonly OrderDetail[],
): OrderDetail[] {
  const serverById = new Map(
    serverDetails.flatMap((detail) => detail.detail_id == null ? [] : [[detail.detail_id, detail] as const]),
  );

  return currentDetails.map((detail) => {
    const server = detail.detail_id == null ? undefined : serverById.get(detail.detail_id);
    return {
      ...detail,
      ...(server
        ? {
            cut_job: server.cut_job ?? null,
            bath_cut_job: server.bath_cut_job ?? null,
            bazis_cut_sets: server.bazis_cut_sets ?? [],
            bazis_projects: server.bazis_projects ?? [],
          }
        : {}),
      doweling: noteRequiresDoweling(detail.note) || detail.doweling === true,
    };
  });
}

export function formatOrderRefreshSuccessMessage(
  response: Pick<OrderRefreshResponse, 'updatedDowelingDetailIds' | 'statusAutomation'>,
): string {
  const parts = [
    response.updatedDowelingDetailIds.length > 0
      ? `Обновлено. Присадка установлена для ${response.updatedDowelingDetailIds.length} поз.`
      : 'Заказ и связи с документами обновлены',
  ];

  if (response.statusAutomation) {
    parts.push(
      `Автостатусы: проверено правил ${response.statusAutomation.evaluatedRuleCount}, `
      + `действий ${response.statusAutomation.executedActionCount}`,
    );
  }

  return parts.join('; ');
}
