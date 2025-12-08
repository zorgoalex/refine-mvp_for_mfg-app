/**
 * Утилита для отправки данных заказа на Vercel API для безопасного экспорта в Google Drive
 *
 * Архитектура: Frontend → Vercel API → Google Apps Script → Google Drive
 */

import type { GenerateOrderExcelParams } from './generateOrderExcel';

/**
 * Кастомная ошибка загрузки на GAS
 */
export class UploadToApiError extends Error {
  constructor(message: string, public originalError?: unknown) {
    super(message);
    this.name = 'UploadToApiError';
  }
}

/**
 * Формирование сводок (summary) из деталей
 */
function getCommonValue(details: any[], getValue: (detail: any) => string | null | undefined): string {
  if (details.length === 0) return '';

  const values = details.map(getValue).filter(v => v); // Убрать null/undefined
  if (values.length === 0) return '';

  const firstValue = values[0];
  const allSame = values.every(v => v === firstValue);

  return allSame ? firstValue : '';
}

/**
 * Отправка данных заказа на Vercel API для безопасного экспорта в Google Drive
 *
 * @param params - Параметры заказа (order, details, client)
 * @returns Ответ от API с информацией о созданном файле на Google Drive
 */
export async function uploadOrderExcelToApi(
  params: GenerateOrderExcelParams & { fileName: string }
): Promise<{
  success: boolean;
  fileName?: string;
  folder?: string;
  xlsxUrl?: string;
  error?: string;
}> {
  try {
    const { order, details, client, clientPhone } = params;

    // Парсинг даты заказа
    const orderDate = typeof order.order_date === 'string'
      ? new Date(order.order_date)
      : order.order_date;
    const orderYear = orderDate.getFullYear();
    const orderMonth = orderDate.getMonth() + 1; // 1-12

    // Формирование сводок из деталей
    const millingSummary = getCommonValue(details, d => d.milling_type?.milling_type_name);
    const edgeSummary = getCommonValue(details, d => d.edge_type?.edge_type_name);
    const filmSummary = getCommonValue(details, d => d.film?.film_name);
    const materialSummary = getCommonValue(details, d => d.material?.material_name);

    // Формирование массива items из деталей
    const items = details.map(detail => ({
      detailNumber: detail.detail_number || 0, // Номер позиции (с пропусками)
      height: detail.length || 0, // В БД "length" = высота
      width: detail.width || 0,
      quantity: detail.quantity || 1,
      itemType: detail.milling_type?.milling_type_name || '',
      edge: detail.edge_type?.edge_type_name || '',
      note: detail.notes || '',
      price: detail.milling_cost_per_sqm || 0,
      film: detail.film?.film_name || '',
    }));

    // Извлечение данных присадки и конструктора из _exportData
    const exportData = (order as any)._exportData || {};
    const prisadkaName = exportData.prisadkaName || '';
    const prisadkaDesignerName = exportData.prisadkaDesignerName || '';

    // Формирование JSON для отправки на Vercel API (без apiKey - добавится на сервере)
    const orderPayload = {
      orderName: order.order_name || '',
      orderId: String(order.order_id),
      prisadkaName, // Номер присадки из dowelling_order_name
      prisadkaDesignerName, // Конструктор присадки из design_engineer (emd.full_name)
      orderDate: order.order_date,
      clientName: client?.client_name || 'Не указан',
      clientPhone: clientPhone || '',
      millingSummary,
      edgeSummary,
      filmSummary,
      materialSummary,
      orderYear,
      orderMonth,
      items,
    };

    console.log('[uploadToApi] Sending to Vercel API: /api/order-export-to-drive');
    console.log('[uploadToApi] Payload:', orderPayload);

    // Отправка POST запроса на Vercel API (безопасный прокси к GAS)
    const response = await fetch('/api/order-export-to-drive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(orderPayload),
    });

    const data = await response.json();

    console.log('[uploadToApi] API response:', data);

    if (!data.success) {
      throw new UploadToApiError(
        data.error || 'Ошибка экспорта на Google Drive',
        { status: response.status, data }
      );
    }

    return data;
  } catch (error) {
    console.error('[uploadToApi] Ошибка отправки на API:', error);

    if (error instanceof UploadToApiError) {
      throw error;
    }

    throw new UploadToApiError(
      'Не удалось отправить данные на сервер',
      error
    );
  }
}

/**
 * Обработка ошибок загрузки
 */
export function handleUploadError(error: unknown): string {
  if (error instanceof UploadToApiError) {
    return error.message;
  }

  if (error instanceof TypeError && error.message.includes('fetch')) {
    return 'Ошибка сети. Проверьте подключение к интернету.';
  }

  if (typeof error === 'object' && error !== null) {
    const err = error as any;

    if (err.status === 403 || err.originalError?.status === 403) {
      return 'Доступ запрещен. Проверьте настройки API-ключа.';
    }

    if (err.status === 400 || err.originalError?.status === 400) {
      return 'Некорректные данные. Попробуйте еще раз.';
    }

    if (err.status === 500 || err.originalError?.status === 500) {
      return 'Ошибка Google Apps Script. Попробуйте позже.';
    }

    if (err.message?.toLowerCase().includes('timeout')) {
      return 'Превышено время ожидания. Попробуйте еще раз.';
    }
  }

  return 'Неизвестная ошибка при отправке данных. Попробуйте еще раз.';
}
