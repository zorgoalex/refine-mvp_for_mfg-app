import { useGetIdentity } from '@refinedev/core';
import { Checkbox, Tag, Typography, message } from 'antd';
import { Tooltip } from '../../ui/tooltipDelay';
import { useState } from 'react';

import { ApiError, isApiError } from '../../api/apiError';
import { ordersApi } from '../../api/ordersApi';
import { formatDateTime } from '../../utils/dateFormat';
import { procurementMarkedTooltip, procurementProgressText, type ResourceDemandLine } from './resourceKinds';

const MANAGE_PROCUREMENT_PERMISSION = 'procurement.manage';

/**
 * Право на отметку закупа + признак «права ещё загружаются» — состояние
 * загрузки прав никогда не трактуется как «нет прав» (чекбокс остаётся
 * disabled, пока identity не подгрузилась).
 */
export function useProcurementPermission(): { canManage: boolean; manageLoading: boolean } {
  const { data: identity, isLoading } = useGetIdentity<{ permissions?: string[] }>();
  return {
    canManage: (identity?.permissions ?? []).includes(MANAGE_PROCUREMENT_PERMISSION),
    manageLoading: isLoading,
  };
}

export interface ProcurementCheckboxProps {
  orderId: number;
  line: ResourceDemandLine;
  canManage: boolean;
  manageLoading: boolean;
  /** Список/карточку нужно перечитать после команды — и при успехе, и при конфликте. */
  onChanged: () => void;
}

/** Чекбокс «Закуплено» одной строки потребности. Рендерить только при `capabilities.procurement`. */
export function ProcurementCheckbox({ orderId, line, canManage, manageLoading, onChanged }: ProcurementCheckboxProps) {
  const [pending, setPending] = useState(false);
  const procurement = line.procurement;
  if (!procurement) return null;

  const tooltip = procurement.purchased
    ? procurementMarkedTooltip(
      procurement.markedByName,
      procurement.markedAt ? formatDateTime(procurement.markedAt) : null,
    )
    : null;

  const handleChange = async (checked: boolean) => {
    setPending(true);
    try {
      await ordersApi.setResourceProcurement(orderId, line.resourceKey, {
        purchased: checked,
        expectedVersion: procurement.version,
        expectedDemandFingerprint: line.demandFingerprint ?? '',
      });
      onChanged();
    } catch (error) {
      reportProcurementError(error);
      // Конфликт или нет — сервер знает актуальное состояние лучше нас: перечитываем, а не откатываем вслепую.
      onChanged();
    } finally {
      setPending(false);
    }
  };

  const checkboxNode = (
    <Checkbox
      checked={procurement.purchased}
      disabled={manageLoading || !canManage || pending}
      onChange={(event) => void handleChange(event.target.checked)}
    />
  );

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {tooltip ? <Tooltip title={tooltip}>{checkboxNode}</Tooltip> : checkboxNode}
      {line.orphan && <Tag style={{ marginInlineEnd: 0 }}>больше не требуется</Tag>}
      {procurement.changedSinceMark && <Tag color="warning" style={{ marginInlineEnd: 0 }}>потребность изменилась</Tag>}
    </span>
  );
}

function reportProcurementError(error: unknown): void {
  if (isApiError(error, 'PROCUREMENT_DEMAND_CHANGED')) {
    message.warning(`${error.message}. Потребность изменилась — проверьте и отметьте снова.`);
    return;
  }
  if (
    isApiError(error, 'PROCUREMENT_VERSION_CONFLICT')
    || isApiError(error, 'PROCUREMENT_RESOURCE_NOT_IN_ORDER')
    || isApiError(error, 'PROCUREMENT_DISABLED')
  ) {
    message.warning(error instanceof ApiError ? error.message : 'Отметка закупа изменилась. Список обновлён.');
    return;
  }
  if (error instanceof ApiError) {
    message.error(error.message || 'Не удалось изменить отметку «Закуплено»');
    return;
  }
  message.error('Не удалось изменить отметку «Закуплено»');
}

/** Прогресс «Закуплено x/y» заказа/группы материалов. Рендерить только при `capabilities.procurement`. */
export function ProcurementProgressTag({
  summary,
}: {
  summary: { total: number; purchased: number } | undefined | null;
}) {
  if (!summary || summary.total === 0) {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  const complete = summary.purchased >= summary.total;
  return <Tag color={complete ? 'success' : undefined}>{procurementProgressText(summary)}</Tag>;
}
