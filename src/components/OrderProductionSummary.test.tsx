import React from 'react';
import { create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { OrderProductionSummary } from './OrderProductionSummary';
import { overlayDetailProductionStatuses } from '../utils/orderProductionSummary';

describe('OrderProductionSummary', () => {
  const order = { productionStatusName: 'Упакован', productionDetailCount: 2,
    productionUnassignedCount: 0, productionDistinctStatusCount: 1 };
  const statuses = [
    { production_status_id: 6, production_status_name: 'Закатан', sort_order: 60 },
    { production_status_id: 7, production_status_name: 'Упакован', sort_order: 70 },
  ];
  const badge = (view: ReturnType<typeof create>) => view.root.findByProps({ role: 'img' });
  const label = (view: ReturnType<typeof create>) => view.root.findByProps({ className: 'order-production-summary__text' }).children;
  it('live detail updates override stale header counts and minimum name', () => {
    const view = create(<OrderProductionSummary order={order} details={[
      { production_status_id: 7 }, { production_status_id: 6 },
    ]} statuses={statuses} />);
    expect(label(view)).toEqual(['Закатан']);
    expect(badge(view).props['data-mixed']).toBe(true);
    expect(badge(view).props.title).toContain('Разные этапы · самый ранний: Закатан');
    view.update(<OrderProductionSummary order={order} details={[
      { production_status_id: 7 }, { production_status_id: null },
    ]} statuses={statuses} />);
    expect(label(view)).toEqual(['Без статуса']);
    expect(badge(view).props['data-mixed']).toBe(true);
    expect(badge(view).props['aria-label']).toContain('без статуса: 1 из 2');
    view.update(<OrderProductionSummary order={order} details={[]} statuses={statuses} />);
    expect(label(view)).toEqual(['Нет деталей']);
    expect(badge(view).props['data-mixed']).toBe(false);
  });
  it('uniform production keeps a single background and explains HDF exclusion', () => {
    const view = create(<OrderProductionSummary order={order} />);
    expect(label(view)).toEqual(['Упакован']);
    expect(badge(view).props['data-mixed']).toBe(false);
    expect(badge(view).props.title).toContain('ХДФ исключён');
  });
  it('uses the table live overlay including null, ignores absent IDs and preserves empty membership', () => {
    const raw = [{ detail_id: 1, production_status_id: 7 }, { detail_id: 2, production_status_id: 7 }];
    const view = create(<OrderProductionSummary order={order} statuses={statuses}
      details={overlayDetailProductionStatuses(raw, new Map([[2, 6], [999, null]]))} />);
    expect(label(view)).toEqual(['Закатан']);
    expect(badge(view).props['data-mixed']).toBe(true);
    view.update(<OrderProductionSummary order={order} statuses={statuses}
      details={overlayDetailProductionStatuses(raw, new Map([[2, null]]))} />);
    expect(label(view)).toEqual(['Без статуса']);
    expect(badge(view).props.title).toContain('1 из 2');
    view.update(<OrderProductionSummary order={order} statuses={statuses}
      details={overlayDetailProductionStatuses([], new Map([[2, 6]]))} />);
    expect(label(view)).toEqual(['Нет деталей']);
    expect(raw.map(detail => detail.production_status_id)).toEqual([7, 7]);
  });
});
