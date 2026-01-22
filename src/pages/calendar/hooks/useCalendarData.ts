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

  // Загружаем заказы из orders_view
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
      pageSize: 1000,
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
      staleTime: 30000,
      refetchOnWindowFocus: true,
    },
  });

  // Получаем order_id всех загруженных заказов
  const orderIds = useMemo(() => {
    return (data?.data || []).map((order) => order.order_id);
  }, [data?.data]);

  // Загружаем order_details отдельным запросом (как в list.tsx)
  const { data: detailsData } = useList({
    resource: 'order_details',
    filters: [
      {
        field: 'order_id',
        operator: 'in',
        value: orderIds,
      },
      {
        field: 'delete_flag',
        operator: 'eq',
        value: false,
      },
    ],
    pagination: {
      pageSize: 10000,
    },
    queryOptions: {
      enabled: orderIds.length > 0,
      staleTime: 30000,
    },
  });

  // Загружаем справочник milling_types
  const { data: millingTypesData } = useList({
    resource: 'milling_types',
    pagination: { pageSize: 1000 },
    queryOptions: { staleTime: 60000 },
  });

  // Загружаем справочник materials
  const { data: materialsData } = useList({
    resource: 'materials',
    pagination: { pageSize: 1000 },
    queryOptions: { staleTime: 60000 },
  });

  // Загружаем справочник production_statuses
  const { data: productionStatusesData } = useList({
    resource: 'production_statuses',
    pagination: { pageSize: 100 },
    queryOptions: { staleTime: 60000 },
  });

  // Загружаем production_status_events для всех заказов
  const { data: productionEventsData } = useList({
    resource: 'production_status_events',
    filters: [
      {
        field: 'order_id',
        operator: 'in',
        value: orderIds,
      },
    ],
    pagination: { pageSize: 10000 },
    queryOptions: {
      enabled: orderIds.length > 0,
      staleTime: 30000,
    },
  });

  // Загружаем связи с присадками для заказов
  const { data: dowelingLinksData } = useList({
    resource: 'order_doweling_links',
    filters: [
      {
        field: 'order_id',
        operator: 'in',
        value: orderIds,
      },
    ],
    pagination: { pageSize: 10000 },
    queryOptions: {
      enabled: orderIds.length > 0,
      staleTime: 30000,
    },
  });

  // Создаём Map для быстрого поиска названия фрезеровки
  const millingTypesMap = useMemo(() => {
    const map = new Map<number, string>();
    (millingTypesData?.data || []).forEach((mt: any) => {
      map.set(mt.milling_type_id, mt.milling_type_name);
    });
    return map;
  }, [millingTypesData]);

  // Создаём Map для быстрого поиска названия материала
  const materialsMap = useMemo(() => {
    const map = new Map<number, string>();
    (materialsData?.data || []).forEach((m: any) => {
      map.set(m.material_id, m.material_name);
    });
    return map;
  }, [materialsData]);

  // Создаём Map для быстрого поиска названия статуса производства
  const productionStatusesMap = useMemo(() => {
    const map = new Map<number, string>();
    (productionStatusesData?.data || []).forEach((ps: any) => {
      map.set(ps.production_status_id, ps.production_status_name);
    });
    return map;
  }, [productionStatusesData]);

  // Создаём Map для быстрого поиска кода статуса производства по ID
  const productionStatusIdToCode = useMemo(() => {
    const map = new Map<number, string>();
    (productionStatusesData?.data || []).forEach((ps: any) => {
      if (ps.production_status_code) {
        map.set(ps.production_status_id, ps.production_status_code);
      }
    });
    return map;
  }, [productionStatusesData]);

  // Группируем события по order_id и получаем коды пройденных этапов
  const passedCodesByOrderId = useMemo(() => {
    const map: Record<number, string[]> = {};
    (productionEventsData?.data || []).forEach((event: any) => {
      if (event.order_id) {
        if (!map[event.order_id]) {
          map[event.order_id] = [];
        }
        const code = productionStatusIdToCode.get(event.production_status_id);
        if (code && !map[event.order_id].includes(code)) {
          map[event.order_id].push(code);
        }
      }
    });
    return map;
  }, [productionEventsData, productionStatusIdToCode]);

  // Группируем присадки по order_id (берём последнюю по order_doweling_link_id)
  const dowelingByOrderId = useMemo(() => {
    const map: Record<number, string> = {};
    const links = dowelingLinksData?.data || [];
    // Группируем по order_id
    const linksByOrder: Record<number, any[]> = {};
    links.forEach((link: any) => {
      if (!linksByOrder[link.order_id]) {
        linksByOrder[link.order_id] = [];
      }
      linksByOrder[link.order_id].push(link);
    });
    // Берём последнюю присадку для каждого заказа
    Object.entries(linksByOrder).forEach(([orderId, orderLinks]) => {
      const sorted = orderLinks.sort(
        (a: any, b: any) => b.order_doweling_link_id - a.order_doweling_link_id
      );
      const latestLink = sorted[0];
      if (latestLink?.doweling_order?.doweling_order_name) {
        map[Number(orderId)] = latestLink.doweling_order.doweling_order_name;
      }
    });
    return map;
  }, [dowelingLinksData]);

  // Группируем детали по order_id и добавляем milling_type_name, material_name, production_status_name
  const detailsByOrderId = useMemo(() => {
    const map: Record<number, Array<{
      milling_type?: { milling_type_name: string };
      material?: { material_name: string };
      production_status_id?: number;
      production_status_name?: string;
    }>> = {};
    (detailsData?.data || []).forEach((detail: any) => {
      if (!map[detail.order_id]) {
        map[detail.order_id] = [];
      }
      map[detail.order_id].push({
        milling_type: detail.milling_type_id
          ? { milling_type_name: millingTypesMap.get(detail.milling_type_id) || '' }
          : undefined,
        material: detail.material_id
          ? { material_name: materialsMap.get(detail.material_id) || '' }
          : undefined,
        production_status_id: detail.production_status_id,
        production_status_name: detail.production_status_id
          ? productionStatusesMap.get(detail.production_status_id)
          : undefined,
      });
    });
    return map;
  }, [detailsData, millingTypesMap, materialsMap, productionStatusesMap]);

  // Группируем заказы по датам и добавляем order_details + doweling_order_name + production_status_name
  const ordersByDate = useMemo(() => {
    if (!data?.data) {
      return {};
    }

    // Добавляем order_details, doweling_order_name и production_status_name к каждому заказу
    const ordersWithDetails = data.data.map((order) => {
      const details = detailsByOrderId[order.order_id] || [];

      // Агрегируем уникальные статусы производства из всех деталей
      const productionStatusNames = details
        .map((d) => d.production_status_name)
        .filter((name): name is string => !!name);
      const uniqueStatuses = Array.from(new Set(productionStatusNames));
      // Объединяем все статусы в одну строку (для поиска ключевых слов)
      const aggregatedProductionStatus = uniqueStatuses.join(' ').toLowerCase();

      return {
        ...order,
        order_details: details,
        doweling_order_name: dowelingByOrderId[order.order_id] || undefined,
        // Приоритет: статус уровня заказа (из orders_view), затем агрегация из деталей
        production_status_name: order.production_status_name || aggregatedProductionStatus,
        // Пройденные этапы производства из production_status_events
        passedProductionCodes: passedCodesByOrderId[order.order_id] || [],
      };
    });

    return groupOrdersByDate(ordersWithDetails);
  }, [data?.data, detailsByOrderId, dowelingByOrderId, passedCodesByOrderId]);

  return {
    ordersByDate,
    isLoading,
    refetch,
    error: isError ? (error as Error) : undefined,
  };
};
