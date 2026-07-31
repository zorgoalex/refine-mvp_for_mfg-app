import type { OrderDetailColumnDefinition } from '../orders/components/tables/OrderDetailColumnSettings';
import type { OrderStatusBoardVisualFlow } from './model';

export const STATUS_BOARD_COLUMN_PREFERENCE_KEYS: Record<
  OrderStatusBoardVisualFlow,
  string
> = {
  order: 'statusBoardOrder',
  production: 'statusBoardProduction',
  cnc_today: 'statusBoardCnc',
};

export const STATUS_BOARD_LABELS: Record<OrderStatusBoardVisualFlow, string> = {
  order: 'Статусы заказов',
  production: 'Производство',
  cnc_today: 'МДФ-работы',
};

export const CNC_STATUS_BOARD_COLUMN_DEFINITIONS: OrderDetailColumnDefinition[] = [
  { key: 'parsed', label: 'Файлы на станке' },
  { key: 'completed', label: 'Распилено' },
  { key: 'baths', label: 'Карты ванн' },
  { key: 'baths_ready', label: 'Готовы к закатке' },
  { key: 'orders', label: 'Заказы' },
];

export function filterVisibleStatusBoardColumns<T extends { key: string }>(
  columns: readonly T[],
  hiddenKeys: readonly string[],
): T[] {
  const hidden = new Set(hiddenKeys);
  return columns.filter((column) => !hidden.has(column.key));
}
