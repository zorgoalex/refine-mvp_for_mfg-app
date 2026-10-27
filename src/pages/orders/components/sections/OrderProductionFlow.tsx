import React, { useMemo } from 'react';
import {
  buildOrderProductionFlow,
  type OrderProductionFlowDetail,
  type OrderProductionFlowStatus,
} from '../../orderProductionFlow';
import { formatNumber } from '../../../../utils/numberFormat';
import { Tooltip } from '../../../../ui/tooltipDelay';
import { SETTING_KEYS } from '../../../../hooks/useAppSettings';
import { useOrderAppSettings } from '../../../../hooks/useOrderAppSettings';
import { buildProductionStagesDisplayConfig } from '../../../../utils/productionWorkflow';
import type { ProductionStatusRef, ProductionWorkflowConfig } from '../../../../types/productionWorkflow';
import { PRODUCTION_STATUS_CODE_LETTERS } from '../../../../types/orders';
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

/**
 * Collapsed-spoiler summary: every stage as its letter code with the number of pieces
 * currently in it. Deliberately faint — it must not draw attention.
 */
export const OrderProductionFlowCodes: React.FC<Omit<OrderProductionFlowProps, 'loading'>> = ({ details, statuses }) => {
  const { getSetting } = useOrderAppSettings();
  const workflow = getSetting<ProductionWorkflowConfig>(SETTING_KEYS.PRODUCTION_WORKFLOW_DEFAULT);
  const codeToLetter = useMemo(() => {
    const refs = statuses
      .filter((status) => typeof status.production_status_code === 'string')
      .map((status) => ({
        production_status_id: status.production_status_id,
        production_status_code: status.production_status_code,
        production_status_name: status.production_status_name,
        sort_order: status.sort_order,
        is_active: status.is_active !== false,
      })) as unknown as ProductionStatusRef[];
    if (refs.length === 0) return undefined;
    return buildProductionStagesDisplayConfig({
      workflow,
      statuses: refs,
      workflowKey: SETTING_KEYS.PRODUCTION_WORKFLOW_DEFAULT,
    }).display?.codeToLetter;
  }, [statuses, workflow]);
  const flow = useMemo(() => buildOrderProductionFlow(details, statuses), [details, statuses]);

  if (flow.stages.length === 0) return null;

  return (
    <span className="order-production-flow-codes" aria-label="Детали заказа по этапам производства">
      {flow.stages.map((stage) => {
        const rawLetter = stage.statusId === null
          ? '—'
          : (stage.code ? codeToLetter?.[stage.code] || PRODUCTION_STATUS_CODE_LETTERS[stage.code] : '') || stage.name;
        const letter = rawLetter.trim().slice(0, 1).toUpperCase() || '?';
        return (
          <Tooltip
            key={stage.key}
            title={`${stage.name}: ${formatNumber(stage.quantity, 0)} шт. · ${formatNumber(stage.positions, 0)} поз.`}
          >
            <span className="order-production-flow-codes__item" data-empty={stage.positions === 0}>
              <b>{letter}</b>
              {formatNumber(stage.quantity, 0)}
            </span>
          </Tooltip>
        );
      })}
    </span>
  );
};
