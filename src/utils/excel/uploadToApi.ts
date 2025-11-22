/**
 * Утилиты для загрузки Excel файлов на API сервис
 */

import { buildOrderExcelBuffer, type GenerateOrderExcelParams } from './generateOrderExcel';

/**
 * Кастомная ошибка загрузки на API
 */
export class UploadToApiError extends Error {
  constructor(message: string, public originalError?: unknown) {
    super(message);
    this.name = 'UploadToApiError';
  }
}

/**
 * Конвертация ArrayBuffer в base64 строку
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const uint8Array = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }
  return btoa(binary);
}

/**
 * Загрузка Excel файла заказа на API сервис для экспорта в Google Drive
 *
 * @param params - Параметры генерации Excel (order, details, client)
 * @param fileName - Имя файла для сохранения
 * @returns Ответ от API с информацией о загруженном файле
 */
export async function uploadOrderExcelToApi(
  params: GenerateOrderExcelParams & { fileName: string }
): Promise<{
  ok: boolean;
  fileId?: string;
  webViewLink?: string;
  webContentLink?: string;
  error?: string;
}> {
  try {
    // 1. Генерация Excel буфера
    const arrayBuffer = await buildOrderExcelBuffer(params);

    // 2. Конвертация в base64
    const base64 = arrayBufferToBase64(arrayBuffer);

    // 3. Получение API-ключа из переменных окружения
    const apiKey = import.meta.env.VITE_ORDER_EXPORT_API_SECRET;
    if (!apiKey) {
      throw new UploadToApiError(
        'API ключ не настроен. Проверьте переменную окружения VITE_ORDER_EXPORT_API_SECRET.'
      );
    }

    // 4. Отправка POST запроса на API
    const response = await fetch('/api/order-export-to-drive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        fileName: params.fileName,
        base64,
      }),
    });

    // 5. Обработка ответа
    const data = await response.json();

    if (!response.ok) {
      throw new UploadToApiError(
        data.error || `Ошибка HTTP ${response.status}`,
        { status: response.status, data }
      );
    }

    return data;
  } catch (error) {
    console.error('Ошибка загрузки Excel на API:', error);

    if (error instanceof UploadToApiError) {
      throw error;
    }

    throw new UploadToApiError(
      'Не удалось загрузить файл на сервер',
      error
    );
  }
}

/**
 * Обработка ошибок загрузки на API
 *
 * Возвращает понятное пользователю сообщение об ошибке
 */
export function handleUploadError(error: unknown): string {
  // Обработка кастомной ошибки UploadToApiError
  if (error instanceof UploadToApiError) {
    return error.message;
  }

  // Обработка ошибок сети
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return 'Ошибка сети. Проверьте подключение к интернету.';
  }

  // Обработка ошибок по коду состояния
  if (typeof error === 'object' && error !== null) {
    const err = error as any;

    // 403 Forbidden - неправильный API-ключ
    if (err.status === 403 || err.originalError?.status === 403) {
      return 'Доступ запрещен. Проверьте настройки API-ключа.';
    }

    // 400 Bad Request - проблемы с данными
    if (err.status === 400 || err.originalError?.status === 400) {
      return 'Некорректные данные файла. Попробуйте еще раз.';
    }

    // 500 Internal Server Error - проблемы на сервере
    if (err.status === 500 || err.originalError?.status === 500) {
      return 'Ошибка сервера. Попробуйте позже или обратитесь к администратору.';
    }

    // Timeout
    if (err.message?.toLowerCase().includes('timeout')) {
      return 'Превышено время ожидания. Попробуйте еще раз.';
    }
  }

  // Общая ошибка
  return 'Неизвестная ошибка при загрузке файла. Попробуйте еще раз.';
}
