import { useMemo } from 'react';
import { useList } from '@refinedev/core';
import { CalendarOrder, CalendarDataResult } from '../types/calendar';
import { groupOrdersByDate } from '../utils/groupOrdersByDate';
import { formatDateForApi } from '../utils/dateUtils';

/**
 * Hook для загрузки данных заказов календаря из Hasura GraphQL
 * @param startDate - начальная дата диапазона
 * @param endDate - конечная дата диапазона
 * @returns объект с сгруппированными заказами, состоянием загрузки и функцией refetch
 */
export const useCalendarData = (
  startDate: Date,
  endDate: Date
): CalendarDataResult => {
  // Форматируем даты для API запроса
  const startDateStr = formatDateForApi(startDate);
  const endDateStr = formatDateForApi(endDate);

  // Загружаем заказы из Hasura через Refine useList
  const { data, isLoading, refetch, isError, error } = useList<CalendarOrder>({
    resource: 'orders_view',
    filters: [
      {
        field: 'planned_completion_date',
        operator: 'gte',
        value: startDateStr,
      },
      {
        field: 'planned_completion_date',
        operator: 'lte',
        value: endDateStr,
      },
    ],
    pagination: {
      pageSize: 1000, // Загружаем до 1000 заказов (достаточно для 16 дней)
      current: 1,
    },
    sorters: [
      {
        field: 'planned_completion_date',
        order: 'asc',
      },
      {
        field: 'order_id',
        order: 'asc',
      },
    ],
    queryOptions: {
      // Кэшируем данные на 30 секунд
      staleTime: 30000,
      // Refetch при фокусировке окна
      refetchOnWindowFocus: true,
    },
  });

  // Группируем заказы по датам
  const ordersByDate = useMemo(() => {
    if (!data?.data) {
      return {};
    }

    return groupOrdersByDate(data.data);
  }, [data?.data]);

  return {
    ordersByDate,
    isLoading,
    refetch,
    error: isError ? (error as Error) : undefined,
  };
};
