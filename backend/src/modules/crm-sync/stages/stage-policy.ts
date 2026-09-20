import { ApiError } from '../../../common/errors/api-error';

export interface DealStage {
  id: string;
  name: string;
  sort: number;
  color: string;
  semantics: '' | 'S' | 'F';
}
export interface StageConfig {
  member_id: string | null;
  domain: string | null;
  category_id: number | null;
  completed_status_id: number | null;
  enabled: boolean;
  binding_locked: boolean;
  version: number;
  epoch: number;
}
export interface StageOrder {
  order_id: string;
  order_name: string;
  order_status_id: number;
  order_kind: string;
  delete_flag: boolean;
  client_id: string;
  version: number;
  bitrix_id: string | null;
  mapping_status: string | null;
  source_system: string | null;
  request_deal: string | null;
  linked_order_id: string | null;
  request_state: string | null;
}
export function stageError(
  code: string,
  message: string,
  status = 409
): ApiError {
  return new ApiError(status, `BITRIX24_STAGE_${code}`, message);
}
export function normalizeStages(
  rows: Array<Record<string, unknown>>
): DealStage[] {
  return rows.map((row) => {
    const id = row.STATUS_ID;
    const name = row.NAME;
    const sort = Number(row.SORT);
    const semantics = row.SEMANTICS ?? row.CATEGORY_SEMANTICS ?? '';
    if (
      typeof id !== 'string' ||
      !id ||
      typeof name !== 'string' ||
      !Number.isFinite(sort) ||
      !['', 'S', 'F'].includes(String(semantics))
    )
      throw stageError(
        'CATALOG_INVALID',
        'Некорректный ответ справочника стадий',
        502
      );
    return {
      id,
      name,
      sort,
      color: typeof row.COLOR === 'string' ? row.COLOR : '',
      semantics: semantics === 'S' ? 'S' : semantics === 'F' ? 'F' : '',
    };
  });
}
export function verifyDeal(
  order: StageOrder,
  remote: Record<string, unknown>,
  config: StageConfig
): void {
  if (order.order_kind !== 'production_order' || order.delete_flag)
    throw stageError(
      'ORDER_INELIGIBLE',
      'Заказ не является действующим производственным заказом'
    );
  if (
    !order.bitrix_id ||
    !['active', 'failed'].includes(order.mapping_status ?? '')
  )
    throw stageError(
      'MAPPING_MISSING',
      'Ожидает подтверждённой связи со сделкой'
    );
  if (
    String(remote.id) !== order.bitrix_id ||
    remote.categoryId == null ||
    Number(remote.categoryId) !== config.category_id
  )
    throw stageError(
      'CATEGORY_CONFLICT',
      'Сделка находится в другой воронке или связь не совпадает'
    );
  const erpOrigin =
    remote.originatorId === 'MEBELKZ_ERP' &&
    remote.originId === `ORDER_${order.order_id}`;
  const converted =
    order.source_system === 'bitrix24' &&
    order.request_state === 'converted' &&
    order.request_deal === order.bitrix_id &&
    order.linked_order_id === order.order_id;
  if (order.source_system === 'erp' ? !erpOrigin : !converted)
    throw stageError(
      'OWNERSHIP_CONFLICT',
      'Не подтверждена принадлежность сделки заказу ERP'
    );
  if (converted && remote.originatorId === 'MEBELKZ_ERP' && !erpOrigin)
    throw stageError('OWNERSHIP_CONFLICT', 'Противоречивый ERP ID в сделке');
  if (typeof remote.stageId !== 'string' || !remote.stageId)
    throw stageError('RESPONSE_INVALID', 'Bitrix не вернул стадию сделки', 502);
}
export function targetStage(
  orderStatusId: number,
  stageId: string | undefined,
  stages: DealStage[],
  completed: number | null
): DealStage {
  const stage = stages.find((row) => row.id === stageId);
  if (!stage)
    throw stageError(
      'UNMAPPED',
      'Для статуса заказа нет действующего сопоставления'
    );
  if (stage.semantics !== (orderStatusId === completed ? 'S' : ''))
    throw stageError(
      'SEMANTICS_CONFLICT',
      'Семантика стадии не соответствует статусу ERP'
    );
  return stage;
}
export function provisioningRows(
  statuses: Array<{ id: number; name: string; color: string }>,
  stages: DealStage[],
  category: number
): Array<{
  statusId: number;
  code: string;
  id: string;
  name: string;
  color: string;
  sort: number;
}> {
  const success = Math.min(
    ...stages.filter((s) => s.semantics === 'S').map((s) => s.sort)
  );
  const last = Math.max(
    0,
    ...stages.filter((s) => s.semantics === '').map((s) => s.sort)
  );
  if (!Number.isFinite(success) || success - last <= statuses.length)
    throw stageError(
      'NO_SORT_SPACE',
      'Нет места перед успешной стадией. Существующие стадии автоматически не переставляются'
    );
  return statuses.map((s, i) => {
    const code = `ERP_S_${s.id}`;
    const id = category === 0 ? code : `C${category}:${code}`;
    if (id.length > 22)
      throw stageError(
        'CODE_TOO_LONG',
        'Код стадии превышает ограничение Bitrix'
      );
    return {
      statusId: s.id,
      code,
      id,
      name: s.name,
      color: s.color,
      sort: last + i + 1,
    };
  });
}
