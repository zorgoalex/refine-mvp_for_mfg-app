import React from 'react';
import { Tag, Tooltip } from 'antd';

export const ORDER_DELETED_TAG_TEXT = 'удалён';
export const ORDER_DELETED_TOOLTIP = 'Заказ удалён; ссылка ведёт в карточку удалённого заказа';
export const ORDER_DELETED_REFERENCE_ROW_CLASS = 'order-deleted-reference-row';
export const ORDER_DELETED_REFERENCE_LINE_CLASS = 'order-deleted-reference-line';

export function orderDeletedReferenceClassName(
  deleted?: boolean | null,
  baseClassName = '',
): string {
  return [baseClassName, deleted ? ORDER_DELETED_REFERENCE_ROW_CLASS : ''].filter(Boolean).join(' ');
}

export function hasDeletedOrderReference(
  refs?: readonly { orderDeleted?: boolean | null; deleted?: boolean | null }[] | null,
): boolean {
  return refs?.some((ref) => ref.orderDeleted === true || ref.deleted === true) ?? false;
}

export function OrderDeletedTag({ deleted }: { deleted?: boolean | null }): JSX.Element | null {
  if (!deleted) return null;

  return (
    <Tooltip title={ORDER_DELETED_TOOLTIP}>
      <Tag color="red" style={{ marginInlineEnd: 0 }}>{ORDER_DELETED_TAG_TEXT}</Tag>
    </Tooltip>
  );
}
