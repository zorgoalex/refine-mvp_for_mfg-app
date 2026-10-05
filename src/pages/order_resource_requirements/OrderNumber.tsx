import { Typography } from 'antd';
import type { CSSProperties } from 'react';

import { resolveOrderNumberText, resolveProjectCode, type OrderNumberInput } from './orderNumber';

export interface OrderNumberProps extends OrderNumberInput {
  /** Заказ открывается по клику — номер становится ссылкой, код проекта остаётся обычным текстом рядом. */
  onClick?: () => void;
  strong?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * Номер заказа первым, затем код проекта мелким серым текстом после него —
 * единое представление заказа во всех вкладках экрана «Потребности заказов в
 * ресурсах» и на экране снабжения (план «номер заказа первым»). Код проекта
 * берётся из `projectCode`, а если его нет в DTO — выводится из `fullNumber`
 * (см. `orderNumber.ts`); когда код проекта неизвестен, показывается только номер.
 */
export function OrderNumber({ orderName, orderId, projectCode, fullNumber, onClick, strong, className, style }: OrderNumberProps) {
  const number = resolveOrderNumberText(orderName, orderId);
  const project = resolveProjectCode({ orderName, projectCode, fullNumber });
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, ...style }}>
      {onClick ? (
        <Typography.Link strong={strong} onClick={onClick}>{number}</Typography.Link>
      ) : (
        // Обычный span — наследует цвет родителя (внутри <Link> номер остаётся цветом ссылки).
        <span style={strong ? { fontWeight: 600 } : undefined}>{number}</span>
      )}
      {project && (
        <Typography.Text type="secondary" style={{ fontSize: '0.85em' }}>
          {project}
        </Typography.Text>
      )}
    </span>
  );
}
