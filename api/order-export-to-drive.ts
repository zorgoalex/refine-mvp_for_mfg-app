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
 *   - payments: Array<{paymentType, paymentDate, amount}> - Платежи по заказу
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
  const startTime = Date.now();

  // Проверка метода - только POST
  if (req.method !== 'POST') {
    console.log('[order-export-to-drive] Method not allowed:', req.method);
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
      console.error('[order-export-to-drive] CRITICAL: Missing environment variables');
      console.error('[order-export-to-drive] GAS_WEBAPP_URL:', gasUrl ? 'SET' : 'NOT SET');
      console.error('[order-export-to-drive] GAS_API_KEY:', apiKey ? 'SET' : 'NOT SET');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error'
      });
    }

    // Получение данных заказа из фронтенда
    const orderData = req.body;

    // Валидация обязательных полей
    if (!orderData.orderName || !orderData.orderId || !orderData.items) {
      console.error('[order-export-to-drive] Missing required fields:', {
        hasOrderName: !!orderData.orderName,
        hasOrderId: !!orderData.orderId,
        hasItems: !!orderData.items
      });
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: orderName, orderId, and items are required'
      });
    }

    // Формирование payload для GAS с apiKey (добавляется ТОЛЬКО на сервере)
    const gasPayload = {
      apiKey, // SECURE: добавляется только здесь, не приходит с фронтенда
      ...orderData,
    };

    const payloadSize = JSON.stringify(gasPayload).length;
    console.log('[order-export-to-drive] ===== REQUEST START =====');
    console.log('[order-export-to-drive] Order ID:', orderData.orderId);
    console.log('[order-export-to-drive] Order Name:', orderData.orderName);
    console.log('[order-export-to-drive] Items count:', orderData.items?.length || 0);
    console.log('[order-export-to-drive] Payments count:', orderData.payments?.length || 0);
    console.log('[order-export-to-drive] Payload size:', payloadSize, 'bytes');
    console.log('[order-export-to-drive] GAS URL:', gasUrl.substring(0, 50) + '...');
    console.log('[order-export-to-drive] Payload summary:', {
      orderName: orderData.orderName,
      orderId: orderData.orderId,
      clientName: orderData.clientName,
      orderDate: orderData.orderDate,
      itemsCount: orderData.items?.length,
      paymentsCount: orderData.payments?.length,
      millingSummary: orderData.millingSummary,
      materialSummary: orderData.materialSummary,
    });

    // Прокси запроса к Google Apps Script с timeout
    // ВАЖНО: ЖДЕМ ответ от GAS, иначе файлы не создаются (serverless functions отменяют pending промисы)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55000); // 55 секунд timeout (с запасом для cold start GAS)

    const fetchStartTime = Date.now();
    console.log('[order-export-to-drive] Sending request to GAS (awaiting response)...');

    const gasResponse = await fetch(gasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(gasPayload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const fetchDuration = Date.now() - fetchStartTime;
    console.log('[order-export-to-drive] GAS response received in', fetchDuration, 'ms');
    console.log('[order-export-to-drive] Response status:', gasResponse.status);

    if (!gasResponse.ok) {
      const responseText = await gasResponse.text();
      console.error('[order-export-to-drive] GAS HTTP error:', {
        status: gasResponse.status,
        statusText: gasResponse.statusText,
        responsePreview: responseText.substring(0, 200)
      });
      throw new Error(`GAS HTTP error: ${gasResponse.status} ${gasResponse.statusText}`);
    }

    const responseText = await gasResponse.text();
    console.log('[order-export-to-drive] Response body preview:', responseText.substring(0, 200));

    let gasData: GASResponse;
    try {
      gasData = JSON.parse(responseText) as GASResponse;
    } catch (parseError) {
      console.error('[order-export-to-drive] JSON parse error:', parseError);
      console.error('[order-export-to-drive] Response text:', responseText.substring(0, 500));
      throw new Error('Invalid JSON response from GAS');
    }

    if (!gasData.success) {
      console.error('[order-export-to-drive] GAS returned error:', gasData.error);
      return res.status(500).json({
        success: false,
        error: 'Apps Script error',
        details: gasData.error,
      });
    }

    const totalDuration = Date.now() - startTime;
    console.log('[order-export-to-drive] ===== SUCCESS =====');
    console.log('[order-export-to-drive] Excel created successfully');
    console.log('[order-export-to-drive] File:', gasData.fileName);
    console.log('[order-export-to-drive] Folder:', gasData.folder);
    console.log('[order-export-to-drive] Total duration:', totalDuration, 'ms');
    console.log('[order-export-to-drive] ===== REQUEST END =====');

    // Успешный ответ
    return res.status(200).json({
      success: true,
      fileName: gasData.fileName,
      folder: gasData.folder,
      xlsxUrl: gasData.xlsxUrl,
    });

  } catch (err: any) {
    const totalDuration = Date.now() - startTime;

    // Подробное логирование ошибки
    console.error('[order-export-to-drive] ===== ERROR =====');
    console.error('[order-export-to-drive] Error type:', err.name);
    console.error('[order-export-to-drive] Error message:', err.message);
    console.error('[order-export-to-drive] Error stack:', err.stack);
    console.error('[order-export-to-drive] Duration before error:', totalDuration, 'ms');

    if (err.name === 'AbortError') {
      console.error('[order-export-to-drive] Request timeout (55s) - GAS cold start or slow processing');
      return res.status(504).json({
        success: false,
        error: 'Request timeout - GAS took too long to respond',
        details: 'The request to Google Apps Script exceeded 55 seconds. This may be due to cold start or slow processing.'
      });
    }

    console.error('[order-export-to-drive] ===== ERROR END =====');

    return res.status(500).json({
      success: false,
      error: 'Internal error during export',
      details: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
    });
  }
}
