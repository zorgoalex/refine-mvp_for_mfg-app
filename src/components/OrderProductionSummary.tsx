import React from 'react';
import { orderProductionBadge, productionSummaryFromDetails, type OrderProductionSummaryInput } from '../utils/orderProductionSummary';
import './orderProductionSummary.css';

export function OrderProductionSummary({ order, details, statuses }: {
  order: OrderProductionSummaryInput;
  details?: Parameters<typeof productionSummaryFromDetails>[0];
  statuses?: readonly { production_status_id: number; production_status_name?: string; sort_order?: number | null }[];
}) {
  let summary = order;
  if (details) {
    const counts = productionSummaryFromDetails(details);
    const ids = new Set(details.filter(d => d.delete_flag !== true).map(d => d.production_status_id));
    const least = statuses?.filter(s => ids.has(s.production_status_id))
      .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity) || a.production_status_id - b.production_status_id)[0];
    const name = least?.production_status_name
      ?? (counts.production_distinct_status_count === 1 ? `Этап №${[...ids].find(id => id != null)}` : undefined);
    summary = {
      ...counts, production_status_name: name,
    };
  }
  const badge = orderProductionBadge(summary);
  const description = `${badge.description}. Состав обычных деталей заказа. ХДФ исключён. Сводка не подтверждает готовность всех деталей.`;
  return <span className="order-production-summary" data-mixed={badge.mixed}
    role="img" aria-label={description} title={description}>
    <span className="order-production-summary__text" aria-hidden="true">{badge.label}</span>
  </span>;
}
