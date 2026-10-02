import { ApiError } from '../../../../common/errors/api-error';
import { ORDER_FORM_MIME, ORDER_SEND_FILE_MAX_BYTES, orderForm, type OrderFormCode } from '../order-send.types';
import { renderOrderExcel } from './excel-form';
import { productionProjection, type OrderFormData } from './order-form-data';
import { renderOrderPdf } from './pdf-form';

export interface GeneratedOrderForm { bytes: Buffer; fileName: string; mimeType: string; extension: 'pdf' | 'xlsx' }

const RENDER_TIMEOUT_MS = 10_000;

/**
 * Builds one form. The projection depends on the form AND the rights: a production form never
 * carries financial data, a financial form only for a user who sees finances (checked by the caller
 * too). Rendering is bounded; a failure never reserves the frequency threshold.
 */
export async function generateOrderForm(data: OrderFormData, code: OrderFormCode, canViewFinancials: boolean): Promise<GeneratedOrderForm> {
  const form = orderForm(code);
  if (form.financial && !canViewFinancials) {
    throw new ApiError(403, 'ORDER_SEND_FINANCIALS_REQUIRED', 'Форма с ценами доступна только при праве видеть финансы');
  }
  const projected = form.financial ? data : productionProjection(data);
  const render = form.format === 'pdf'
    ? renderOrderPdf(projected, form.financial)
    : renderOrderExcel(projected, form.financial ? 'full' : 'omit');
  let timer: NodeJS.Timeout | undefined;
  const bytes = await Promise.race([
    render,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ApiError(504, 'ORDER_SEND_RENDER_FAILED', 'Форма не успела подготовиться')), RENDER_TIMEOUT_MS); }),
  ]).catch((error) => {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, 'ORDER_SEND_RENDER_FAILED', 'Не удалось подготовить форму заказа');
  }).finally(() => clearTimeout(timer));
  if (bytes.byteLength > ORDER_SEND_FILE_MAX_BYTES) throw new ApiError(413, 'ORDER_SEND_FILE_TOO_LARGE', 'Файл формы больше 10 МБ');
  return { bytes, fileName: fileName(data, code, form.format), mimeType: ORDER_FORM_MIME[form.format], extension: form.format };
}

function fileName(data: OrderFormData, code: OrderFormCode, extension: string): string {
  const part = (value: string) => value.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').slice(0, 60);
  const suffix = code.startsWith('production_') ? ' для производства' : '';
  const client = data.clientName ? ` ${part(data.clientName)}` : '';
  return `Заказ ${part(data.orderName)}${client}${suffix}.${extension}`.slice(0, 150);
}
