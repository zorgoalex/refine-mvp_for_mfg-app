import React, { useMemo } from 'react';
import {
  buildOrderProductionFlow,
  type OrderProductionFlowDetail,
  type OrderProductionFlowStatus,
} from '../../orderProductionFlow';
import { formatNumber } from '../../../../utils/numberFormat';
import './orderProductionFlow.css';

interface OrderProductionFlowProps {
  details: readonly OrderProductionFlowDetail[];
  statuses: readonly OrderProductionFlowStatus[];
  loading?: boolean;
}

/** «Ход производства»: where the order details are right now. Display only. */
export const OrderProductionFlow: React.FC<OrderProductionFlowProps> = ({ details, statuses, loading = false }) => {
  const flow = useMemo(() => buildOrderProductionFlow(details, statuses), [details, statuses]);

  if (flow.stages.length === 0) {
    return (
      <span className="order-production-flow__empty">
        {loading ? 'Загрузка этапов…' : 'Нет деталей и этапов производства'}
      </span>
    );
  }

  return (
    <div className="order-production-flow">
      <ol className="order-production-flow__stages" aria-label="Детали заказа по этапам производства">
        {flow.stages.map((stage) => (
          <li
            key={stage.key}
            className="order-production-flow__stage"
            data-empty={stage.positions === 0}
            data-unassigned={stage.statusId === null}
          >
            <span className="order-production-flow__name" title={stage.name}>{stage.name}</span>
            <span className="order-production-flow__count">
              {stage.positions > 0
                ? `${formatNumber(stage.positions, 0)} поз. · ${formatNumber(stage.quantity, 0)} шт.`
                : '—'}
            </span>
            <span className="order-production-flow__bar" aria-hidden>
              <i style={{ width: `${Math.round(stage.share * 100)}%` }} />
            </span>
          </li>
        ))}
      </ol>
      <div className="order-production-flow__caption">
        Всего {formatNumber(flow.totalPositions, 0)} поз. · {formatNumber(flow.totalQuantity, 0)} шт.
        {' '}Показано, на каких этапах сейчас находятся обычные детали заказа; ХДФ исключён.
        {' '}Сводка не подтверждает готовность заказа.
      </div>
    </div>
  );
};
