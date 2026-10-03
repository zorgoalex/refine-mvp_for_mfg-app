import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { generateOrderForm } from './forms';
import type { OrderFormData } from './forms/order-form-data';
import { renderOrderSendCaption, validateOrderSendCaption } from './order-send-caption';
import { parseOrderSendCommand, parseOrderSendSettings } from './order-send.dto';
import { maskPhone, normalizeClientPhone } from './order-send-phone';

const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (error) { return error instanceof ApiError ? error.code : String(error); } };

describe('client phone', () => {
  it.each([
    ['87014952060', '77014952060'],
    ['8 701 495 20 60', '77014952060'],
    ['+7 (701) 495-20-60', '77014952060'],
    ['87014952060-897', '77014952060'],
    ['8 701 495 20 60 доб. 12', '77014952060'],
    ['87014952060, 87771234567', '77014952060'],
    ['8708 953 00 96', '77089530096'],
    ['  +77014952060  ', '77014952060'],
  ])('%s → %s', (raw, expected) => expect(normalizeClientPhone(raw)).toBe(expected));

  it.each(['870149520601', '7014952060', '12345', '8 701 495', 'телефон'])('%s is refused', (raw) => {
    expect(code(() => normalizeClientPhone(raw))).toBe('CLIENT_PHONE_INVALID');
  });

  it('missing phone and the mask', () => {
    expect(code(() => normalizeClientPhone(''))).toBe('CLIENT_PHONE_MISSING');
    expect(code(() => normalizeClientPhone(null))).toBe('CLIENT_PHONE_MISSING');
    expect(maskPhone('77014952060')).toBe('7701***2060');
  });
});

describe('caption and DTO', () => {
  it('renders known variables and refuses unknown ones', () => {
    expect(renderOrderSendCaption('Заказ {order_name}, {{скобки}}', { order_name: '230725', client: '', order_date: '', completion_date: '', form: '' }))
      .toBe('Заказ 230725, {скобки}');
    expect(code(() => validateOrderSendCaption('{phone}'))).toBe('VALIDATION_ERROR');
  });

  it('settings: strict, unique groups, interval 1..1440', () => {
    const base = { version: 1, enabled: true, minIntervalMinutes: 1, sendWindowMinutes: 0, clientForms: ['order_pdf'], clientCaption: '', chats: [] };
    expect(code(() => parseOrderSendSettings(base))).toBe('ok');
    expect(code(() => parseOrderSendSettings({ ...base, minIntervalMinutes: 10, sendWindowMinutes: 5 }))).toBe('ok');
    expect(code(() => parseOrderSendSettings({ ...base, minIntervalMinutes: 10, sendWindowMinutes: 6 }))).toBe('VALIDATION_ERROR');
    expect(code(() => parseOrderSendSettings({ ...base, minIntervalMinutes: 1, sendWindowMinutes: 1 }))).toBe('VALIDATION_ERROR');
    expect(code(() => parseOrderSendSettings({ ...base, minIntervalMinutes: 0 }))).toBe('VALIDATION_ERROR');
    expect(code(() => parseOrderSendSettings({ ...base, extra: 1 }))).toBe('VALIDATION_ERROR');
    const chat = { chatKey: null, groupChatId: '120363338054016575@g.us', label: 'Цех', forms: ['production_pdf'], caption: '' };
    expect(code(() => parseOrderSendSettings({ ...base, chats: [chat, chat] }))).toBe('VALIDATION_ERROR');
    expect(code(() => parseOrderSendSettings({ ...base, chats: [{ ...chat, groupChatId: '77014952060@c.us' }] }))).toBe('VALIDATION_ERROR');
  });

  it('command: client or chat target, known form, uuid key', () => {
    const key = '1b4e28ba-2fa1-4d2b-883f-0016d3cca427';
    expect(code(() => parseOrderSendCommand({ target: { kind: 'client' }, form: 'order_pdf', idempotencyKey: key }))).toBe('ok');
    expect(code(() => parseOrderSendCommand({ target: { kind: 'chat' }, form: 'order_pdf', idempotencyKey: key }))).toBe('VALIDATION_ERROR');
    expect(code(() => parseOrderSendCommand({ target: { kind: 'client' }, form: 'invoice', idempotencyKey: key }))).toBe('VALIDATION_ERROR');
  });
});

function order(details: number): OrderFormData {
  return {
    orderId: 1, orderName: 'E2E-Тест-PDF', orderDate: new Date('2026-10-01T00:00:00Z'), completionDate: new Date('2026-10-15T00:00:00Z'),
    clientId: 1, clientName: 'Тест Клиент', clientPhone: '8 701 495 20 60', managerId: '1', createdBy: '1',
    totalAmount: 987654, discount: 0, finalAmount: 987654, paidAmount: 111111, prisadkaName: 'П-12', prisadkaDesignerName: 'Иванов',
    headerMaterial: null,
    details: Array.from({ length: details }, (_, index) => ({
      detailId: index + 1, height: 700 + index, width: 400, quantity: 1, millingType: 'Фасад', edgeType: 'R3', film: index % 2 ? 'Белый' : 'Дуб',
      material: 'МДФ 16', note: `Деталь-${index + 1}`, doweling: index === 0, millingCostPerSqm: 54321, detailCost: null,
    })),
    payments: [{ type: 'ТестКаспи', date: new Date('2026-10-02T00:00:00Z'), amount: 111111 }],
  };
}

async function pdfText(bytes: Buffer): Promise<{ pages: number; text: string }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  let text = '';
  for (let page = 1; page <= document.numPages; page += 1) {
    const content = await (await document.getPage(page)).getTextContent();
    text += content.items.map((item) => ('str' in item ? item.str : '')).join(' ') + '\n';
  }
  return { pages: document.numPages, text };
}

describe('order forms', () => {
  it('a production PDF of 120 details keeps every detail across pages and no money', async () => {
    const form = await generateOrderForm(order(120), 'production_pdf', true);
    expect(form.mimeType).toBe('application/pdf');
    expect(form.fileName).toBe('Заказ E2E-Тест-PDF Тест Клиент для производства.pdf');
    const { pages, text } = await pdfText(form.pages[0]);
    expect(pages).toBeGreaterThan(1);
    for (let index = 1; index <= 120; index += 1) expect(text).toContain(`Деталь-${index}`);
    expect(text).toContain('Присадка');
    expect(text).not.toMatch(/54\s?321|987\s?654|111\s?111|ТестКаспи/);
  }, 60_000);

  it('the order PDF carries prices, totals and payments', async () => {
    const { text } = await pdfText((await generateOrderForm(order(3), 'order_pdf', true)).pages[0]);
    expect(text).toMatch(/54\s?321/);
    expect(text).toMatch(/987\s?654/);
    expect(text).toContain('ТестКаспи');
  });

  it('the order PDF shows the stored detail cost (it wins over area × rate) and area × rate otherwise', async () => {
    const data = order(2);
    // 0.7 × 0.4 m² × 54 321 = 15 209.88; the first detail has a manual cost of 777.
    data.details[0] = { ...data.details[0], height: 700, width: 400, detailCost: 777, millingCostPerSqm: 54321 };
    data.details[1] = { ...data.details[1], height: 700, width: 400, detailCost: null, millingCostPerSqm: 54321 };
    const { text } = await pdfText((await generateOrderForm(data, 'order_pdf', true)).pages[0]);
    expect(text).toContain('777');
    expect(text.match(/15\s?209,88/g)).toHaveLength(1);
  });

  it('a rendered caption never exceeds the stored limit of 1000 characters', () => {
    const template = `${'а'.repeat(990)}{client}`;
    expect(validateOrderSendCaption(template)).toBe(template);
    const text = renderOrderSendCaption(template, { order_name: '', client: 'К'.repeat(50), order_date: '', completion_date: '', form: '' });
    expect(text.length).toBe(1000);
  });

  it('a financial form needs finances; Excel forms build from the backend template', async () => {
    await expect(generateOrderForm(order(3), 'order_excel', false)).rejects.toMatchObject({ code: 'ORDER_SEND_FINANCIALS_REQUIRED' });
    const excel = await generateOrderForm(order(60), 'order_excel', true);
    expect(excel.extension).toBe('xlsx');
    expect(excel.pages[0].subarray(0, 2).toString()).toBe('PK');
  });
});

describe('WAHA client never logs a query', () => {
  it('safePath drops the query string', async () => {
    const source = await readFile(resolve(__dirname, '../waha.client.ts'), 'utf8');
    expect(source).toContain('const route = path.split("?")[0];');
  });
});
