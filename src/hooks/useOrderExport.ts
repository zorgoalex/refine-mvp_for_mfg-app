/**
 * Hook for exporting orders to Google Drive
 *
 * Автоматически экспортирует заказ в Excel и загружает в Google Drive
 * Используется в формах edit/create для автоэкспорта после сохранения
 */

import { useState } from 'react';
import { useDataProvider } from '@refinedev/core';
import { message } from 'antd';
import { uploadOrderExcelToApi, handleUploadError } from '../utils/excel/uploadToApi';
import { generateOrderFileName } from '../utils/excel/fileNameGenerator';

interface Order {
  order_id: number;
  order_name: string;
  order_date: string | Date;
  client?: { client_name: string } | null;
}

interface OrderDetail {
  detail_id: number;
  length: number | null;
  width: number | null;
  quantity: number;
  area?: number | null;
  milling_cost_per_sqm?: number | null;
  detail_cost?: number | null;
  notes?: string | null;
  milling_type_id?: number | null;
  edge_type_id?: number | null;
  film_id?: number | null;
  material_id?: number | null;
}

interface UseOrderExportResult {
  exportToDrive: (order: Order) => Promise<void>;
  isUploading: boolean;
}

/**
 * Hook для экспорта заказов в Google Drive
 *
 * @returns {UseOrderExportResult} Функция экспорта и статус загрузки
 *
 * @example
 * const { exportToDrive, isUploading } = useOrderExport();
 *
 * // В onMutationSuccess:
 * await exportToDrive(order);
 */
export const useOrderExport = (): UseOrderExportResult => {
  const dataProvider = useDataProvider();
  const [isUploading, setIsUploading] = useState(false);

  /**
   * Экспорт заказа в Google Drive
   *
   * 1. Загружает детали заказа
   * 2. Загружает справочники (materials, milling_types, edge_types, films)
   * 3. Создает Maps для маппинга ID → названия
   * 4. Генерирует имя файла
   * 5. Вызывает uploadOrderExcelToApi()
   * 6. Показывает notification о результате
   */
  const exportToDrive = async (order: Order): Promise<void> => {
    // Проверка наличия order
    if (!order || !order.order_id) {
      console.warn('useOrderExport: order or order_id is missing');
      return;
    }

    console.log('[useOrderExport] Starting export for order:', order.order_id);
    console.log('[useOrderExport] Full order object:', order);

    setIsUploading(true);

    try {
      // 1. Загрузить детали заказа
      console.log('[useOrderExport] Fetching order_details from DB...');
      const detailsResult = await dataProvider().getList({
        resource: 'order_details',
        filters: [
          { field: 'order_id', operator: 'eq', value: order.order_id },
        ],
        pagination: { current: 1, pageSize: 1000 },
        sorters: [{ field: 'detail_id', order: 'asc' }],
      });

      console.log('[useOrderExport] DB response detailsResult:', detailsResult);
      const details = detailsResult.data || [];
      console.log('[useOrderExport] Extracted details array length:', details.length);
      console.log('[useOrderExport] Details:', details);

      // Проверка наличия деталей
      if (details.length === 0) {
        console.warn(`[useOrderExport] No details found for order ${order.order_id}`);
        console.warn('[useOrderExport] Skipping export - no details to export');
        // Не показываем ошибку пользователю, просто пропускаем экспорт
        return;
      }

      console.log(`[useOrderExport] Found ${details.length} details, proceeding with export`);

      // 2. Загрузить справочники для маппинга
      const [
        materialsResult,
        millingTypesResult,
        edgeTypesResult,
        filmsResult,
      ] = await Promise.all([
        dataProvider().getList({ resource: 'materials', pagination: { current: 1, pageSize: 1000 } }),
        dataProvider().getList({ resource: 'milling_types', pagination: { current: 1, pageSize: 1000 } }),
        dataProvider().getList({ resource: 'edge_types', pagination: { current: 1, pageSize: 1000 } }),
        dataProvider().getList({ resource: 'films', pagination: { current: 1, pageSize: 1000 } }),
      ]);

      // 3. Создать Maps для маппинга ID → объект
      const materialsMap = new Map(
        (materialsResult.data || []).map((m: any) => [m.material_id, { material_name: m.material_name }])
      );
      const millingTypesMap = new Map(
        (millingTypesResult.data || []).map((mt: any) => [mt.milling_type_id, { milling_type_name: mt.milling_type_name }])
      );
      const edgeTypesMap = new Map(
        (edgeTypesResult.data || []).map((et: any) => [et.edge_type_id, { edge_type_name: et.edge_type_name }])
      );
      const filmsMap = new Map(
        (filmsResult.data || []).map((f: any) => [f.film_id, { film_name: f.film_name }])
      );

      // 4. Маппинг деталей с названиями из справочников
      const detailsWithNames = details.map((detail: OrderDetail) => ({
        ...detail,
        // Высота в БД = length детали (исторические причины)
        length: detail.length,
        width: detail.width,
        quantity: detail.quantity,
        milling_cost_per_sqm: detail.milling_cost_per_sqm,
        notes: detail.notes,
        // Подтянуть названия из справочников по ID
        milling_type: detail.milling_type_id
          ? millingTypesMap.get(detail.milling_type_id) || null
          : null,
        edge_type: detail.edge_type_id
          ? edgeTypesMap.get(detail.edge_type_id) || null
          : null,
        film: detail.film_id
          ? filmsMap.get(detail.film_id) || null
          : null,
        material: detail.material_id
          ? materialsMap.get(detail.material_id) || null
          : null,
      }));

      // 5. Генерация имени файла
      const fileName = generateOrderFileName({
        orderId: order.order_id,
        orderName: order.order_name,
        orderDate: order.order_date,
        clientName: order.client?.client_name,
      });

      // 6. Загрузка Excel на API → Google Drive
      const result = await uploadOrderExcelToApi({
        order: {
          order_id: order.order_id,
          order_name: order.order_name,
          order_date: order.order_date,
          client: order.client,
        },
        details: detailsWithNames,
        client: order.client,
        fileName,
      });

      // 7. Показать успешное сообщение
      if (result.ok) {
        message.success(`Заказ успешно выгружен в Google Drive: ${fileName}`);
        console.log('Google Drive file ID:', result.fileId);
      } else {
        throw new Error(result.error || 'Неизвестная ошибка');
      }
    } catch (error) {
      console.error('Ошибка экспорта в Google Drive:', error);

      // Обработка ошибок через handleUploadError
      const errorMessage = handleUploadError(error);
      message.error(`Не удалось выгрузить в Google Drive: ${errorMessage}`);

      // Не прокидываем ошибку дальше - заказ сохранен, экспорт опционален
    } finally {
      setIsUploading(false);
    }
  };

  return {
    exportToDrive,
    isUploading,
  };
};
