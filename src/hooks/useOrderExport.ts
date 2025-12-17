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
    console.log('[useOrderExport] Partial order object received:', order);

    setIsUploading(true);

    try {
      // 1. Загрузить ПОЛНЫЙ заказ из БД (может быть передан только order_id)
      // Используем orders для редактируемых полей + order_doweling_links
      // А также orders_view для агрегированных полей (статусы, площадь)
      console.log('[useOrderExport] Fetching full order from DB...');
      const [{ data: fullOrder }, { data: orderViewData }] = await Promise.all([
        dataProvider().getOne({
          resource: 'orders',
          id: order.order_id,
        }),
        dataProvider().getList({
          resource: 'orders_view',
          filters: [{ field: 'order_id', operator: 'eq', value: order.order_id }],
          pagination: { current: 1, pageSize: 1 },
        }),
      ]);

      if (!fullOrder) {
        throw new Error(`Order ${order.order_id} not found in database`);
      }

      // Добавляем поля из orders_view
      const orderView = orderViewData?.[0] || {};
      fullOrder._viewData = {
        total_area: orderView.total_area || 0,
        planned_completion_date: orderView.planned_completion_date || null,
        order_status_name: orderView.order_status_name || '',
        payment_status_name: orderView.payment_status_name || '',
        issue_date: orderView.issue_date || null,
        production_status_name: orderView.production_status_name || '',
      };

      console.log('[useOrderExport] Full order loaded:', fullOrder);
      console.log('[useOrderExport] View data:', fullOrder._viewData);

      // 1.1 Извлекаем первую присадку из order_doweling_links
      const dowelingLinks = fullOrder.order_doweling_links || [];
      const firstDoweling = dowelingLinks[0]?.doweling_order;
      const prisadkaName = firstDoweling?.doweling_order_name || '';
      const designEngineerId = firstDoweling?.design_engineer_id;
      console.log('[useOrderExport] Prisadka name:', prisadkaName);
      console.log('[useOrderExport] Design engineer ID:', designEngineerId);

      // 1.2 Загрузить имя конструктора по design_engineer_id
      let prisadkaDesignerName = '';
      if (designEngineerId) {
        try {
          const { data: employee } = await dataProvider().getOne({
            resource: 'employees',
            id: designEngineerId,
          });
          prisadkaDesignerName = employee?.full_name || '';
          console.log('[useOrderExport] Design engineer name:', prisadkaDesignerName);
        } catch (err) {
          console.warn('[useOrderExport] Failed to load design engineer:', err);
        }
      }

      // Добавляем данные для экспорта
      fullOrder._exportData = {
        prisadkaName,
        prisadkaDesignerName,
      };

      // 2. Загрузить детали заказа и платежи параллельно
      console.log('[useOrderExport] Fetching order_details and payments from DB...');
      const [detailsResult, paymentsResult] = await Promise.all([
        dataProvider().getList({
          resource: 'order_details',
          filters: [
            { field: 'order_id', operator: 'eq', value: order.order_id },
          ],
          pagination: { current: 1, pageSize: 1000 },
          sorters: [{ field: 'detail_id', order: 'asc' }],
        }),
        dataProvider().getList({
          resource: 'payments',
          filters: [
            { field: 'order_id', operator: 'eq', value: order.order_id },
          ],
          pagination: { current: 1, pageSize: 1000 },
          sorters: [{ field: 'payment_date', order: 'asc' }],
        }),
      ]);

      console.log('[useOrderExport] DB response detailsResult:', detailsResult);
      const details = detailsResult.data || [];
      const payments = paymentsResult.data || [];
      console.log('[useOrderExport] Extracted details array length:', details.length);
      console.log('[useOrderExport] Extracted payments array length:', payments.length);
      console.log('[useOrderExport] Details full data:', details);
      if (details.length > 0) {
        console.log('[useOrderExport] First detail sample:', details[0]);
        console.log('[useOrderExport] Detail fields:', Object.keys(details[0]));
      }

      // Проверка наличия деталей
      if (details.length === 0) {
        console.warn(`[useOrderExport] No details found for order ${order.order_id}`);
        console.warn('[useOrderExport] Skipping export - no details to export');
        // Не показываем ошибку пользователю, просто пропускаем экспорт
        return;
      }

      console.log(`[useOrderExport] Found ${details.length} details and ${payments.length} payments, proceeding with export`);

      // 3. Загрузить клиента (если указан)
      let clientData = null;
      let clientPhone = '';
      if (fullOrder.client_id) {
        console.log('[useOrderExport] Fetching client from DB...');
        try {
          const { data: client } = await dataProvider().getOne({
            resource: 'clients',
            id: fullOrder.client_id,
          });
          clientData = client;
          console.log('[useOrderExport] Client loaded:', clientData);

          // Загрузить телефоны клиента
          const phonesResult = await dataProvider().getList({
            resource: 'client_phones',
            filters: [{ field: 'client_id', operator: 'eq', value: fullOrder.client_id }],
            pagination: { current: 1, pageSize: 100 },
          });
          const phones = phonesResult.data || [];
          const primaryPhone = phones.find((p: any) => p.is_primary) || phones[0];
          if (primaryPhone?.phone_number) {
            // Форматировать телефон как "8 xxx xxx xxxx"
            const digits = primaryPhone.phone_number.replace(/\D/g, '');
            if (digits.length === 11) {
              clientPhone = `8 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 11)}`;
            } else if (digits.length === 10) {
              clientPhone = `8 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`;
            } else {
              clientPhone = primaryPhone.phone_number;
            }
          }
          console.log('[useOrderExport] Client phone:', clientPhone);
        } catch (err) {
          console.warn('[useOrderExport] Failed to load client:', err);
        }
      }

      // 4. Собрать уникальные ID из деталей и платежей для оптимизированной загрузки
      const uniqueMaterialIds = [...new Set(details.map((d: any) => d.material_id).filter(Boolean))];
      const uniqueMillingTypeIds = [...new Set(details.map((d: any) => d.milling_type_id).filter(Boolean))];
      const uniqueEdgeTypeIds = [...new Set(details.map((d: any) => d.edge_type_id).filter(Boolean))];
      const uniqueFilmIds = [...new Set(details.map((d: any) => d.film_id).filter(Boolean))];
      const uniquePaymentTypeIds = [...new Set(payments.map((p: any) => p.type_paid_id).filter(Boolean))];

      console.log(`[useOrderExport] Unique IDs to load: materials=${uniqueMaterialIds.length}, milling=${uniqueMillingTypeIds.length}, edge=${uniqueEdgeTypeIds.length}, films=${uniqueFilmIds.length}, paymentTypes=${uniquePaymentTypeIds.length}`);

      // 5. Загрузить только нужные справочники (оптимизация: 500-1000x меньше данных)
      const [
        materialsResult,
        millingTypesResult,
        edgeTypesResult,
        filmsResult,
        paymentTypesResult,
      ] = await Promise.all([
        uniqueMaterialIds.length > 0
          ? dataProvider().getList({
              resource: 'materials',
              filters: [{ field: 'material_id', operator: 'in', value: uniqueMaterialIds }],
              pagination: { current: 1, pageSize: 1000 },
            })
          : { data: [] },
        uniqueMillingTypeIds.length > 0
          ? dataProvider().getList({
              resource: 'milling_types',
              filters: [{ field: 'milling_type_id', operator: 'in', value: uniqueMillingTypeIds }],
              pagination: { current: 1, pageSize: 1000 },
            })
          : { data: [] },
        uniqueEdgeTypeIds.length > 0
          ? dataProvider().getList({
              resource: 'edge_types',
              filters: [{ field: 'edge_type_id', operator: 'in', value: uniqueEdgeTypeIds }],
              pagination: { current: 1, pageSize: 1000 },
            })
          : { data: [] },
        uniqueFilmIds.length > 0
          ? dataProvider().getList({
              resource: 'films',
              filters: [{ field: 'film_id', operator: 'in', value: uniqueFilmIds }],
              pagination: { current: 1, pageSize: 1000 },
            })
          : { data: [] },
        uniquePaymentTypeIds.length > 0
          ? dataProvider().getList({
              resource: 'payment_types',
              filters: [{ field: 'type_paid_id', operator: 'in', value: uniquePaymentTypeIds }],
              pagination: { current: 1, pageSize: 1000 },
            })
          : { data: [] },
      ]);

      console.log(`[useOrderExport] Loaded references: materials=${materialsResult.data?.length || 0}, milling=${millingTypesResult.data?.length || 0}, edge=${edgeTypesResult.data?.length || 0}, films=${filmsResult.data?.length || 0}, paymentTypes=${paymentTypesResult.data?.length || 0}`);

      // 6. Создать Maps для маппинга ID → объект
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
      const paymentTypesMap = new Map(
        (paymentTypesResult.data || []).map((pt: any) => [pt.type_paid_id, { payment_type_name: pt.type_paid_name }])
      );

      // 4. Маппинг деталей с названиями из справочников
      const detailsWithNames = details.map((detail: any) => ({
        ...detail,
        // Маппинг: height из БД → length для Excel (исторические причины)
        length: detail.height,
        width: detail.width,
        quantity: detail.quantity,
        milling_cost_per_sqm: detail.milling_cost_per_sqm,
        notes: detail.note,
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

      // 7. Маппинг платежей с названиями типов оплаты
      const paymentsWithNames = payments.map((payment: any) => ({
        ...payment,
        payment_type: payment.type_paid_id
          ? paymentTypesMap.get(payment.type_paid_id) || null
          : null,
      }));

      // 8. Генерация имени файла
      const fileName = generateOrderFileName({
        orderId: fullOrder.order_id,
        orderName: fullOrder.order_name,
        orderDate: fullOrder.order_date,
        clientName: clientData?.client_name,
      });

      console.log('[useOrderExport] Generated fileName:', fileName);

      // 9. Загрузка Excel на API → Google Drive
      const result = await uploadOrderExcelToApi({
        order: fullOrder, // Передаем ПОЛНЫЙ заказ со всеми полями
        details: detailsWithNames,
        payments: paymentsWithNames, // Платежи с названиями типов оплаты
        client: clientData, // Передаем объект клиента, а не ID
        clientPhone, // Телефон клиента (форматированный)
        fileName,
      });

      // 7. Показать успешное сообщение
      if (result.success) {
        message.success(`Заказ успешно выгружен в Google Drive: ${result.fileName || fileName}`);
        console.log('[useOrderExport] Excel created successfully');
        console.log('[useOrderExport] File name:', result.fileName);
        console.log('[useOrderExport] Folder:', result.folder);
        console.log('[useOrderExport] URL:', result.xlsxUrl);
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
