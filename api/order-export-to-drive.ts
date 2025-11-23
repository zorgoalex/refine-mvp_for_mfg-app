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
 *   - orderDate: string | Date - дата заказа для создания папок Год/Месяц
 *
 * Response:
 *   - ok: boolean
 *   - fileId: string - ID файла в Google Drive
 *   - webViewLink: string - ссылка для просмотра
 *   - webContentLink: string - ссылка для скачивания
 */

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

// Названия месяцев на русском языке
const MONTH_NAMES = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'
];

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

/**
 * Поиск папки по имени внутри родительской папки
 */
async function findFolderByName(
  drive: ReturnType<typeof getDriveClient>,
  folderName: string,
  parentId: string
): Promise<string | null> {
  const query = [
    `name='${folderName.replace(/'/g, "\\'")}'`,
    `'${parentId}' in parents`,
    `mimeType='application/vnd.google-apps.folder'`,
    `trashed=false`
  ].join(' and ');

  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    pageSize: 1,
  });

  const folders = response.data.files || [];
  return folders.length > 0 ? folders[0].id! : null;
}

/**
 * Создание папки внутри родительской папки
 */
async function createFolder(
  drive: ReturnType<typeof getDriveClient>,
  folderName: string,
  parentId: string
): Promise<string> {
  const fileMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId],
  };

  const response = await drive.files.create({
    requestBody: fileMetadata,
    fields: 'id',
  });

  console.log(`Created folder: ${folderName} (ID: ${response.data.id})`);
  return response.data.id!;
}

/**
 * Получение существующей папки или создание новой
 */
async function getOrCreateFolder(
  drive: ReturnType<typeof getDriveClient>,
  folderName: string,
  parentId: string
): Promise<string> {
  // Сначала ищем существующую папку
  let folderId = await findFolderByName(drive, folderName, parentId);

  // Если не нашли - создаем новую
  if (!folderId) {
    folderId = await createFolder(drive, folderName, parentId);
  }

  return folderId;
}

/**
 * Получение ID целевой папки для сохранения файла
 * Создает иерархию: Корневая папка → Год → Месяц
 */
async function getTargetFolderId(
  drive: ReturnType<typeof getDriveClient>,
  orderDate: string | Date,
  rootFolderId: string
): Promise<string> {
  // Парсим дату заказа
  const date = typeof orderDate === 'string' ? new Date(orderDate) : orderDate;

  if (isNaN(date.getTime())) {
    throw new Error('Invalid order date');
  }

  const year = date.getFullYear().toString();
  const monthIndex = date.getMonth();
  const monthName = MONTH_NAMES[monthIndex];

  console.log(`Processing folder hierarchy: ${year}/${monthName}`);

  // 1. Получить/создать папку года
  const yearFolderId = await getOrCreateFolder(drive, year, rootFolderId);

  // 2. Получить/создать папку месяца внутри папки года
  const monthFolderId = await getOrCreateFolder(drive, monthName, yearFolderId);

  console.log(`Target folder: ${year}/${monthName} (ID: ${monthFolderId})`);
  return monthFolderId;
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
    const { fileName, base64, orderDate } = req.body as {
      fileName?: string;
      base64?: string;
      orderDate?: string | Date;
    };

    if (!fileName || !base64 || !orderDate) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: fileName, base64, and orderDate are required'
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

    // Получение ID корневой папки
    const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    if (!rootFolderId) {
      throw new Error('GOOGLE_DRIVE_FOLDER_ID is not configured');
    }

    // Получение/создание иерархии папок: Год → Месяц
    const targetFolderId = await getTargetFolderId(drive, orderDate, rootFolderId);

    // Метаданные файла
    const fileMetadata = {
      name: fileName,
      parents: [targetFolderId], // Загружаем в папку месяца
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
