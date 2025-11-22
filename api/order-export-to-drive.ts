import type { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';
import { Readable } from 'stream';

/**
 * API-роут для экспорта Excel файлов заказов в Google Drive
 *
 * Метод: POST
 * Headers:
 *   - Content-Type: application/json
 *   - x-api-key: ORDER_EXPORT_API_SECRET
 * Body:
 *   - fileName: string - имя файла (например: "заказ-Ф25-10111-1662-Клиент.xlsx")
 *   - base64: string - Excel файл в формате base64
 *
 * Response:
 *   - ok: boolean
 *   - fileId: string - ID файла в Google Drive
 *   - webViewLink: string - ссылка для просмотра
 *   - webContentLink: string - ссылка для скачивания
 */

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

/**
 * Создает и авторизует Google Drive клиент через Service Account
 */
function getDriveClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

  if (!email || !key) {
    throw new Error('Google Service Account environment variables are not set');
  }

  // Создаем JWT авторизацию для Service Account
  const auth = new google.auth.JWT(
    email,
    undefined,
    // Заменяем escaped переносы строк на реальные
    key.replace(/\\n/g, '\n'),
    SCOPES,
  );

  return google.drive({ version: 'v3', auth });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Проверка метода - только POST
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed. Use POST.'
    });
  }

  try {
    // Проверка API-ключа для защиты endpoint
    const authHeader = req.headers['x-api-key'] as string | undefined;
    const expectedKey = process.env.ORDER_EXPORT_API_SECRET;

    if (!expectedKey) {
      console.error('ORDER_EXPORT_API_SECRET is not configured');
      return res.status(500).json({
        ok: false,
        error: 'Server configuration error'
      });
    }

    if (authHeader !== expectedKey) {
      console.warn('Invalid API key attempt');
      return res.status(403).json({
        ok: false,
        error: 'Forbidden. Invalid API key.'
      });
    }

    // Валидация тела запроса
    const { fileName, base64 } = req.body as { fileName?: string; base64?: string };

    if (!fileName || !base64) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: fileName and base64 are required'
      });
    }

    // Валидация имени файла
    if (!fileName.endsWith('.xlsx')) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid file type. Only .xlsx files are supported.'
      });
    }

    // Декодирование base64 в буфер
    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch (err) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid base64 encoding'
      });
    }

    // Проверка размера файла (максимум 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (buffer.length > maxSize) {
      return res.status(400).json({
        ok: false,
        error: `File size exceeds maximum allowed size of ${maxSize / 1024 / 1024}MB`
      });
    }

    // Инициализация Google Drive клиента
    const drive = getDriveClient();

    // Получение ID папки назначения
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!folderId) {
      throw new Error('GOOGLE_DRIVE_FOLDER_ID is not configured');
    }

    // Метаданные файла
    const fileMetadata = {
      name: fileName,
      parents: [folderId], // Загружаем в указанную папку
    };

    // Медиа контент (сам файл)
    const media = {
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: Readable.from(buffer), // Создаем readable stream из буфера
    };

    console.log(`Uploading file to Google Drive: ${fileName} (${buffer.length} bytes)`);

    // Загрузка файла в Google Drive
    const response = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id, webViewLink, webContentLink', // Возвращаем только нужные поля
    });

    console.log(`File uploaded successfully. ID: ${response.data.id}`);

    // Успешный ответ
    return res.status(200).json({
      ok: true,
      fileId: response.data.id,
      webViewLink: response.data.webViewLink,
      webContentLink: response.data.webContentLink,
    });

  } catch (err: any) {
    // Логирование ошибки
    console.error('Google Drive upload error:', err);

    // Определение типа ошибки
    let errorMessage = 'Upload failed';
    let statusCode = 500;

    if (err.message?.includes('Service Account')) {
      errorMessage = 'Google Service Account configuration error';
      statusCode = 500;
    } else if (err.message?.includes('FOLDER_ID')) {
      errorMessage = 'Google Drive folder configuration error';
      statusCode = 500;
    } else if (err.code === 404) {
      errorMessage = 'Google Drive folder not found. Check GOOGLE_DRIVE_FOLDER_ID.';
      statusCode = 500;
    } else if (err.code === 403) {
      errorMessage = 'Permission denied. Check Service Account permissions for the folder.';
      statusCode = 500;
    } else if (err.code === 401) {
      errorMessage = 'Authentication failed. Check Service Account credentials.';
      statusCode = 500;
    } else if (err.response?.data?.error) {
      // Google API error
      errorMessage = `Google Drive API error: ${err.response.data.error.message}`;
      statusCode = 500;
    }

    return res.status(statusCode).json({
      ok: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}
