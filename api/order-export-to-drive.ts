import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * API-роут для экспорта заказов в Google Drive через Google Apps Script
 *
 * Безопасный прокси: Frontend → Vercel API → GAS → Google Drive
 *
 * Метод: POST
 * Body: Order data (без apiKey - добавляется на сервере)
 *   - orderName: string
 *   - orderId: string
 *   - prisadkaName: string
 *   - orderDate: string
 *   - clientName: string
 *   - clientPhone: string
 *   - millingSummary: string
 *   - edgeSummary: string
 *   - filmSummary: string
 *   - materialSummary: string
 *   - orderYear: number
 *   - orderMonth: number
 *   - items: Array<{height, width, quantity, itemType, edge, note, price, film}>
 *
 * Response:
 *   - success: boolean
 *   - fileName?: string - Имя созданного файла
 *   - folder?: string - Папка на Google Drive
 *   - xlsxUrl?: string - Ссылка на Excel файл
 *   - error?: string - Описание ошибки
 */

type GASResponse = {
  success: boolean;
  error?: string;
  fileName?: string;
  folder?: string;
  xlsxUrl?: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Проверка метода - только POST
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed. Use POST.'
    });
  }

  try {
    // Получение переменных окружения (SECURE - только на сервере)
    const gasUrl = process.env.GAS_WEBAPP_URL;
    const apiKey = process.env.GAS_API_KEY;

    if (!gasUrl || !apiKey) {
      console.error('[order-export-to-drive] GAS_WEBAPP_URL or GAS_API_KEY is not configured');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error'
      });
    }

    // Получение данных заказа из фронтенда
    const orderData = req.body;

    // Валидация обязательных полей
    if (!orderData.orderName || !orderData.orderId || !orderData.items) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: orderName, orderId, and items are required'
      });
    }

    console.log(`[order-export-to-drive] Proxying order ${orderData.orderId} to GAS`);

    // Формирование payload для GAS с apiKey (добавляется ТОЛЬКО на сервере)
    const gasPayload = {
      apiKey, // SECURE: добавляется только здесь, не приходит с фронтенда
      ...orderData,
    };

    // Прокси запроса к Google Apps Script
    const gasResponse = await fetch(gasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(gasPayload),
    });

    if (!gasResponse.ok) {
      throw new Error(`GAS HTTP error: ${gasResponse.status} ${gasResponse.statusText}`);
    }

    const gasData = (await gasResponse.json()) as GASResponse;

    if (!gasData.success) {
      console.error('[order-export-to-drive] GAS error:', gasData.error);
      return res.status(500).json({
        success: false,
        error: 'Apps Script error',
        details: gasData.error,
      });
    }

    console.log(`[order-export-to-drive] Excel created successfully`);
    console.log(`[order-export-to-drive] File: ${gasData.fileName}`);
    console.log(`[order-export-to-drive] Folder: ${gasData.folder}`);

    // Успешный ответ
    return res.status(200).json({
      success: true,
      fileName: gasData.fileName,
      folder: gasData.folder,
      xlsxUrl: gasData.xlsxUrl,
    });

  } catch (err: any) {
    // Логирование ошибки
    console.error('[order-export-to-drive] Error:', err);

    return res.status(500).json({
      success: false,
      error: 'Internal error during export',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}
