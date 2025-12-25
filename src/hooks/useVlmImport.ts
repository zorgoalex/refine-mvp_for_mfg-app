/**
 * Hook для импорта позиций заказа из изображения через VLM API
 *
 * Полный flow:
 * 1. Загрузка изображения
 * 2. Анализ через VLM
 * 3. Парсинг и маппинг результата на структуру OrderDetail
 */

import { useState, useCallback, useRef } from 'react';
import { useVlmApi, VlmAnalyzeResult } from './useVlmApi';

// ============================================================================
// Types
// ============================================================================

export interface ImportedOrderDetail {
  // Основные поля
  detail_name: string;
  height: number;
  width: number;
  quantity: number;

  // Опциональные поля
  price?: number;
  edge?: string;
  note?: string;
  film?: string;
  milling?: string;
  material?: string;
}

export interface VlmImportResult {
  success: boolean;
  items: ImportedOrderDetail[];
  rawContent?: string;
  parseError?: string;
  error?: string;
  imageUrl?: string;
  provider?: string;
  model?: string;
  duration?: number;
}

export type ImportStatus =
  | 'idle'
  | 'uploading'
  | 'analyzing'
  | 'parsing'
  | 'success'
  | 'error';

export interface UseVlmImportResult {
  // State
  status: ImportStatus;
  progress: number; // 0-100
  statusMessage: string;
  error: string | null;
  result: VlmImportResult | null;

  // Methods
  importFromImage: (file: File | Blob) => Promise<VlmImportResult>;
  reset: () => void;
}

// ============================================================================
// Status messages
// ============================================================================

const STATUS_MESSAGES: Record<ImportStatus, string> = {
  idle: 'Готов к импорту',
  uploading: 'Загрузка изображения...',
  analyzing: 'Анализ изображения (может занять до минуты)...',
  parsing: 'Обработка результата...',
  success: 'Импорт завершён',
  error: 'Ошибка импорта',
};

// ============================================================================
// Parser
// ============================================================================

/**
 * Парсит ответ VLM и преобразует в массив ImportedOrderDetail
 */
function parseVlmResponse(result: VlmAnalyzeResult): {
  items: ImportedOrderDetail[];
  parseError?: string;
} {
  // Если уже распарсено
  if (result.items && Array.isArray(result.items)) {
    return {
      items: result.items.map(normalizeItem),
    };
  }

  // Пытаемся распарсить content
  if (!result.content) {
    return { items: [], parseError: 'Empty response content' };
  }

  try {
    // Ищем JSON в ответе
    const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                      result.content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);

    if (!jsonMatch) {
      return { items: [], parseError: 'No JSON found in response' };
    }

    const parsed = JSON.parse(jsonMatch[1]);
    const rawItems = Array.isArray(parsed) ? parsed : (parsed.items || parsed.details || []);

    return {
      items: rawItems.map(normalizeItem),
    };
  } catch (e: any) {
    return { items: [], parseError: e.message };
  }
}

/**
 * Нормализует элемент к структуре ImportedOrderDetail
 */
function normalizeItem(item: any): ImportedOrderDetail {
  return {
    detail_name: item.detail_name || item.name || item.designation || item.title || '',
    height: parseNumber(item.height || item.h),
    width: parseNumber(item.width || item.w),
    quantity: parseNumber(item.quantity || item.qty || item.count) || 1,
    price: parseNumber(item.price || item.cost),
    edge: item.edge || item.edging || item.кромка,
    note: item.note || item.notes || item.comment || item.примечание,
    film: item.film || item.пленка,
    milling: item.milling || item.фрезеровка,
    material: item.material || item.материал,
  };
}

/**
 * Безопасно парсит число
 */
function parseNumber(value: any): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value.replace(/[^\d.,]/g, '').replace(',', '.'));
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

// ============================================================================
// Hook
// ============================================================================

// Progress increment interval (ms) and max progress during analyzing
const PROGRESS_INCREMENT_INTERVAL = 5000; // 5 seconds
const ANALYZING_START_PROGRESS = 50;
const ANALYZING_MAX_PROGRESS = 79; // Before parsing at 80%

export const useVlmImport = (): UseVlmImportResult => {
  const vlmApi = useVlmApi();

  const [status, setStatus] = useState<ImportStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VlmImportResult | null>(null);

  // Ref for progress increment timer
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clear progress timer
  const clearProgressTimer = useCallback(() => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  // Start progress increment timer (1% every 5 sec)
  const startProgressTimer = useCallback(() => {
    clearProgressTimer();
    progressTimerRef.current = setInterval(() => {
      setProgress((prev) => {
        if (prev < ANALYZING_MAX_PROGRESS) {
          return prev + 1;
        }
        return prev;
      });
    }, PROGRESS_INCREMENT_INTERVAL);
  }, [clearProgressTimer]);

  const reset = useCallback(() => {
    clearProgressTimer();
    setStatus('idle');
    setProgress(0);
    setError(null);
    setResult(null);
  }, [clearProgressTimer]);

  const importFromImage = useCallback(async (file: File | Blob): Promise<VlmImportResult> => {
    reset();

    try {
      // 1. Upload
      setStatus('uploading');
      setProgress(20);

      const uploadResult = await vlmApi.uploadImage(file);

      if (!uploadResult.success || !uploadResult.url) {
        throw new Error(uploadResult.error || 'Upload failed');
      }

      // 2. Analyze (with progress timer)
      setStatus('analyzing');
      setProgress(ANALYZING_START_PROGRESS);
      startProgressTimer();

      const analyzeResult = await vlmApi.analyzeImage(uploadResult.url);

      clearProgressTimer();

      if (!analyzeResult.success) {
        throw new Error(analyzeResult.error || 'Analyze failed');
      }

      // 3. Parse
      setStatus('parsing');
      setProgress(80);

      const { items, parseError } = parseVlmResponse(analyzeResult);

      // 4. Success
      setProgress(100);
      setStatus('success');

      const importResult: VlmImportResult = {
        success: true,
        items,
        rawContent: analyzeResult.content,
        parseError,
        imageUrl: uploadResult.url,
        provider: analyzeResult.provider,
        model: analyzeResult.model,
        duration: analyzeResult.duration,
      };

      setResult(importResult);
      return importResult;

    } catch (err: any) {
      clearProgressTimer();
      const errorMsg = err.message || 'Import failed';
      setError(errorMsg);
      setStatus('error');

      const errorResult: VlmImportResult = {
        success: false,
        items: [],
        error: errorMsg,
      };

      setResult(errorResult);
      return errorResult;
    }
  }, [vlmApi, reset, startProgressTimer, clearProgressTimer]);

  return {
    status,
    progress,
    statusMessage: STATUS_MESSAGES[status],
    error,
    result,
    importFromImage,
    reset,
  };
};

export default useVlmImport;
