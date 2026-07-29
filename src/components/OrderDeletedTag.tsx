import React from 'react';
import { Tag, Tooltip } from 'antd';

export const ORDER_DELETED_TAG_TEXT = 'удалён';
export const ORDER_DELETED_TOOLTIP = 'Заказ удалён; ссылка ведёт в карточку удалённого заказа';

export function OrderDeletedTag({ deleted }: { deleted?: boolean | null }): JSX.Element | null {
  if (!deleted) return null;

  return (
    <Tooltip title={ORDER_DELETED_TOOLTIP}>
      <Tag color="red" style={{ marginInlineEnd: 0 }}>{ORDER_DELETED_TAG_TEXT}</Tag>
    </Tooltip>
  );
}
