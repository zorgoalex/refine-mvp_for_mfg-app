import { CalendarOrder, OrdersByDate } from '../types/calendar';
import { formatDateKey } from './dateUtils';

/**
 * Группирует заказы по планируемой дате выдачи
 * @param orders - массив заказов
 * @returns объект с группированными заказами по датам (ключ - DD.MM.YYYY)
 */
export function groupOrdersByDate(orders: CalendarOrder[]): OrdersByDate {
  if (!Array.isArray(orders)) {
    console.warn('groupOrdersByDate: orders is not an array', orders);
    return {};
  }

  const grouped: OrdersByDate = {};

  orders.forEach((order) => {
    if (!order.planned_completion_date) {
      // Пропускаем заказы без планируемой даты
      return;
    }

    try {
      const key = formatDateKey(order.planned_completion_date);

      if (!grouped[key]) {
        grouped[key] = [];
      }

      grouped[key].push(order);
    } catch (error) {
      console.error(
        'Failed to group order by date:',
        order.order_id,
        order.planned_completion_date,
        error
      );
    }
  });

  return grouped;
}

/**
 * Вычисляет общую площадь заказов для массива
 * @param orders - массив заказов
 * @returns суммарная площадь в кв.м.
 */
export function calculateTotalArea(orders: CalendarOrder[]): number {
  return orders.reduce((sum, order) => {
    const area = parseFloat(String(order.total_area || 0));
    return sum + (isNaN(area) ? 0 : area);
  }, 0);
}

/**
 * Проверяет, все ли заказы в массиве выданы
 * @param orders - массив заказов
 * @returns true если все заказы выданы
 */
export function areAllOrdersIssued(orders: CalendarOrder[]): boolean {
  if (orders.length === 0) return false;

  return orders.every(
    (order) =>
      order.order_status?.toLowerCase() === 'выдан' ||
      order.is_issued === true
  );
}

/**
 * Фильтрует заказы по поисковому запросу
 * @param orders - массив заказов
 * @param searchQuery - поисковый запрос
 * @returns отфильтрованный массив заказов
 */
export function filterOrdersBySearch(
  orders: CalendarOrder[],
  searchQuery: string
): CalendarOrder[] {
  if (!searchQuery || searchQuery.trim() === '') {
    return orders;
  }

  const query = searchQuery.toLowerCase().trim();

  return orders.filter((order) => {
    return (
      order.order_name?.toLowerCase().includes(query) ||
      order.client_name?.toLowerCase().includes(query) ||
      order.order_id?.toString().includes(query)
    );
  });
}
