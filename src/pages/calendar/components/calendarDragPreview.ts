import type { CalendarDragPreview, CalendarOrder } from '../types/calendar';

export function buildCalendarOrderDragPreview(
  order: CalendarOrder,
  sourceDate: string,
  node: HTMLElement | null,
): CalendarDragPreview {
  const rect = node?.getBoundingClientRect();
  const computed = node && typeof window !== 'undefined'
    ? window.getComputedStyle(node)
    : null;
  const width = Math.max(136, Math.round(rect?.width ?? 220));
  const height = Math.max(52, Math.round(rect?.height ?? 84));
  const area = order.total_area > 0 ? `${order.total_area.toFixed(2)} кв.м.` : '';
  const details = order.parts_count > 0 ? `${order.parts_count} дет.` : '';

  return {
    backgroundColor: computed?.backgroundColor || '#ffffff',
    borderColor: computed?.borderLeftColor || '#1677ff',
    height,
    meta: [area, details].filter(Boolean).join(' · '),
    orderLabel: `Заказ ${order.order_name}`,
    subtitle: [order.client_name, sourceDate].filter(Boolean).join(' · '),
    width,
  };
}
