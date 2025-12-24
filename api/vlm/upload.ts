import type { VercelRequest, VercelResponse } from '@vercel/node';
import { uploadImage } from '../_lib/vlmClient';
import { extractToken, verifyToken } from '../_lib/verify-token';

/**
 * POST /api/vlm/upload
 *
 * Загружает изображение в VLM API (Cloudflare R2).
 * Требует авторизации пользователя ERP.
 *
 * Body (multipart/form-data):
 *   - file: image/jpeg | image/png (max 5MB)
 *
 * Response:
 *   - success: boolean
 *   - url: string (URL изображения для analyze)
 *   - key: string
 *   - width: number
 *   - height: number
 *   - size: number
 */

// Максимальный размер файла (5MB для ZAI)
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// Разрешённые MIME типы
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export const config = {
  api: {
    bodyParser: false, // Отключаем стандартный парсер для multipart
  },
};

/**
 * Парсит multipart/form-data из raw body
 */
async function parseMultipartBody(req: VercelRequest): Promise<{
  file: Buffer;
  filename: string;
  contentType: string;
}> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';

      // Извлекаем boundary
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
      if (!boundaryMatch) {
        return reject(new Error('No boundary found in content-type'));
      }
      const boundary = boundaryMatch[1] || boundaryMatch[2];

      // Парсим multipart
      const boundaryBuffer = Buffer.from(`--${boundary}`);
      const parts = splitBuffer(body, boundaryBuffer);

      for (const part of parts) {
        const partStr = part.toString('utf8', 0, Math.min(part.length, 1000));

        // Ищем Content-Disposition с именем file
        const dispositionMatch = partStr.match(/Content-Disposition:\s*form-data;\s*name="file"(?:;\s*filename="([^"]+)")?/i);
        if (!dispositionMatch) continue;

        const filename = dispositionMatch[1] || 'image.jpg';

        // Ищем Content-Type
        const typeMatch = partStr.match(/Content-Type:\s*([^\r\n]+)/i);
        const fileContentType = typeMatch ? typeMatch[1].trim() : 'image/jpeg';

        // Ищем начало файла (после двух CRLF)
        const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
        if (headerEnd === -1) continue;

        // Извлекаем файл (без trailing CRLF)
        let fileData = part.slice(headerEnd + 4);
        if (fileData.length >= 2 && fileData[fileData.length - 2] === 0x0d && fileData[fileData.length - 1] === 0x0a) {
          fileData = fileData.slice(0, -2);
        }

        return resolve({
          file: fileData,
          filename,
          contentType: fileContentType,
        });
      }

      reject(new Error('No file found in request'));
    });

    req.on('error', reject);
  });
}

/**
 * Разбивает Buffer по delimiter
 */
function splitBuffer(buffer: Buffer, delimiter: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  let index: number;

  while ((index = buffer.indexOf(delimiter, start)) !== -1) {
    if (index > start) {
      parts.push(buffer.slice(start, index));
    }
    start = index + delimiter.length;
  }

  if (start < buffer.length) {
    parts.push(buffer.slice(start));
  }

  return parts;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  console.log('[vlm/upload] Upload request received');

  try {
    // 1. Проверка авторизации ERP
    const token = extractToken(req);
    if (!token) {
      console.warn('[vlm/upload] No authorization token');
      return res.status(401).json({ success: false, error: 'Authorization required' });
    }

    const user = verifyToken(token);
    if (!user) {
      console.warn('[vlm/upload] Invalid token');
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }

    console.log('[vlm/upload] User authenticated:', { userId: user.userId, username: user.username });

    // 2. Парсинг multipart
    let fileData: { file: Buffer; filename: string; contentType: string };
    try {
      fileData = await parseMultipartBody(req);
    } catch (parseError: any) {
      console.error('[vlm/upload] Parse error:', parseError.message);
      return res.status(400).json({ success: false, error: `Invalid request: ${parseError.message}` });
    }

    const { file, filename, contentType } = fileData;

    console.log('[vlm/upload] File parsed:', { filename, contentType, size: file.length });

    // 3. Валидация файла
    if (!ALLOWED_TYPES.includes(contentType)) {
      return res.status(400).json({
        success: false,
        error: `Invalid file type: ${contentType}. Allowed: ${ALLOWED_TYPES.join(', ')}`,
      });
    }

    if (file.length > MAX_FILE_SIZE) {
      return res.status(400).json({
        success: false,
        error: `File too large: ${(file.length / 1024 / 1024).toFixed(2)}MB. Max: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
      });
    }

    // 4. Загрузка в VLM API
    const startTime = Date.now();
    const uploadResult = await uploadImage(file, filename, contentType);
    const duration = Date.now() - startTime;

    console.log('[vlm/upload] Upload successful:', {
      key: uploadResult.key,
      duration: `${duration}ms`,
      userId: user.userId,
    });

    return res.status(200).json({
      success: true,
      url: uploadResult.url,
      key: uploadResult.key,
      width: uploadResult.width,
      height: uploadResult.height,
      size: uploadResult.size,
      contentType: uploadResult.contentType,
    });

  } catch (error: any) {
    console.error('[vlm/upload] Upload failed:', error);

    return res.status(500).json({
      success: false,
      error: error.message || 'Upload failed',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
}
