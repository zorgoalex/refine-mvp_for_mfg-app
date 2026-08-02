import { ExcelGenerationError } from './excelErrorHandler';
import type { GenerateOrderExcelParams } from './orderExcelBuilder';

export type { GenerateOrderExcelParams } from './orderExcelBuilder';

interface OrderExcelWorkerSuccess {
  requestId: string;
  ok: true;
  buffer: ArrayBuffer;
}

interface OrderExcelWorkerFailure {
  requestId: string;
  ok: false;
  error: {
    name: string;
    message: string;
  };
}

type OrderExcelWorkerResponse = OrderExcelWorkerSuccess | OrderExcelWorkerFailure;

let orderExcelWorkerRequestSeq = 0;

const canBuildOrderExcelInWorker = () => typeof Worker !== 'undefined';

export const buildOrderExcelBufferInWorker = (params: GenerateOrderExcelParams): Promise<ArrayBuffer> => (
  new Promise((resolve, reject) => {
    const requestId = `order-excel-${Date.now()}-${orderExcelWorkerRequestSeq += 1}`;
    let worker: Worker;

    try {
      worker = new Worker(new URL('./orderExcelWorker.ts', import.meta.url), {
        type: 'module',
        name: 'order-excel-worker',
      });
    } catch (error) {
      reject(error);
      return;
    }

    const cleanup = () => {
      worker.terminate();
    };

    worker.onmessage = (event: MessageEvent<OrderExcelWorkerResponse>) => {
      const response = event.data;
      if (!response || response.requestId !== requestId) return;

      cleanup();
      if (response.ok) {
        resolve(response.buffer);
        return;
      }

      if (response.error.name === 'ExcelGenerationError') {
        reject(new ExcelGenerationError(response.error.message));
        return;
      }

      reject(new Error(response.error.message));
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || 'Excel worker failed'));
    };

    worker.onmessageerror = () => {
      cleanup();
      reject(new Error('Excel worker message failed'));
    };

    worker.postMessage({ requestId, params });
  })
);

/**
 * Генерация Excel Blob заказа на основе шаблона.
 * ExcelJS выполняется в module worker, чтобы не блокировать основной UI thread.
 */
export const generateOrderExcel = async (
  params: GenerateOrderExcelParams
): Promise<Blob> => {
  if (!canBuildOrderExcelInWorker()) {
    throw new ExcelGenerationError('Ваш браузер не поддерживает фоновую генерацию Excel');
  }

  try {
    const buffer = await buildOrderExcelBufferInWorker(params);
    return new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  } catch (error) {
    if (error instanceof ExcelGenerationError) {
      throw error;
    }

    throw new ExcelGenerationError(
      'Не удалось запустить фоновую генерацию Excel',
      error instanceof Error ? error : undefined
    );
  }
};

/**
 * Скачать Excel файл.
 */
export const downloadOrderExcel = async (
  params: GenerateOrderExcelParams,
  fileName: string = 'order.xlsx'
) => {
  try {
    const blob = await generateOrderExcel(params);

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;

    document.body.appendChild(link);
    link.click();

    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Ошибка скачивания Excel:', error);
    throw error;
  }
};
