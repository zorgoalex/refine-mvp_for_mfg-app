import { describe, expect, it } from 'vitest';
import {
  normalizeStages,
  provisioningRows,
  targetStage,
  verifyDeal,
  type StageConfig,
  type StageOrder,
} from './stage-policy';
const stages = normalizeStages([
  { STATUS_ID: 'NEW', NAME: 'Новая', SORT: 10, SEMANTICS: '' },
  { STATUS_ID: 'WON', NAME: 'Успех', SORT: 100, SEMANTICS: 'S' },
  { STATUS_ID: 'LOSE', NAME: 'Отказ', SORT: 200, SEMANTICS: 'F' },
]);
const cfg: StageConfig = {
  member_id: 'test',
  domain: 'example.invalid',
  category_id: 0,
  completed_status_id: 8,
  enabled: true,
  binding_locked: true,
  version: 1,
  epoch: 1,
};
const order: StageOrder = {
  order_id: '123',
  order_name: 'Тест',
  order_status_id: 1,
  order_kind: 'production_order',
  delete_flag: false,
  client_id: '1',
  version: 2,
  bitrix_id: '700',
  mapping_status: 'active',
  source_system: 'erp',
  request_deal: null,
  linked_order_id: null,
  request_state: null,
};
const deal = {
  id: 700,
  categoryId: 0,
  stageId: 'NEW',
  originatorId: 'MEBELKZ_ERP',
  originId: 'ORDER_123',
};
describe('stage ownership and semantic policy', () => {
  it('only completed succeeds; issued remains ongoing and can reopen', () => {
    expect(targetStage(8, 'WON', stages, 8).semantics).toBe('S');
    expect(targetStage(7, 'NEW', stages, 8).semantics).toBe('');
    expect(() => targetStage(7, 'WON', stages, 8)).toThrow();
    expect(() => targetStage(8, 'LOSE', stages, 8)).toThrow();
    expect(() => targetStage(8, 'NEW', stages, 8)).toThrow();
    expect(() => targetStage(1, 'deleted', stages, 8)).toThrow();
  });
  it('proves ERP marker or exact converted request, never a mapped id alone', () => {
    expect(() => verifyDeal(order, deal, cfg)).not.toThrow();
    expect(() =>
      verifyDeal(order, { ...deal, originId: 'ORDER_999' }, cfg)
    ).toThrow();
    expect(() =>
      verifyDeal(
        {
          ...order,
          source_system: 'bitrix24',
          request_deal: '700',
          linked_order_id: '123',
          request_state: 'converted',
        },
        { id: 700, categoryId: 0, stageId: 'WON' },
        cfg
      )
    ).not.toThrow();
    expect(() =>
      verifyDeal(
        {
          ...order,
          source_system: 'bitrix24',
          request_deal: '700',
          linked_order_id: '123',
          request_state: 'active',
        },
        deal,
        cfg
      )
    ).toThrow();
  });
  it.each([
    { order_kind: 'crm_request' },
    { order_kind: 'draft' },
    { delete_flag: true },
    { mapping_status: 'deleted' },
  ])('blocks ineligible %j', (patch) =>
    expect(() => verifyDeal({ ...order, ...patch }, deal, cfg)).toThrow()
  );
  it.each([
    { categoryId: 1 },
    { categoryId: null },
    { id: 701 },
    { stageId: null },
  ])('fails closed remote %j', (patch) =>
    expect(() => verifyDeal(order, { ...deal, ...patch }, cfg)).toThrow()
  );
  it('appends deterministic ongoing codes before success without changing existing order', () => {
    expect(
      provisioningRows([{ id: 2, name: 'Работа', color: '#ffffff' }], stages, 3)
    ).toEqual([
      {
        statusId: 2,
        code: 'ERP_S_2',
        id: 'C3:ERP_S_2',
        name: 'Работа',
        color: '#ffffff',
        sort: 11,
      },
    ]);
    expect(() =>
      provisioningRows(
        [{ id: 2, name: 'Работа', color: '' }],
        stages.map((s) => (s.semantics === 'S' ? { ...s, sort: 11 } : s)),
        0
      )
    ).toThrow();
  });
});
