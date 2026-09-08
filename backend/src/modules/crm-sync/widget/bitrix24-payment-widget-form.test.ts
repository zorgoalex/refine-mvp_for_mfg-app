import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parseCreateWidgetPaymentInput } from './bitrix24-payment-widget.dto';

const source = readFileSync(new URL('../../../../assets/bitrix24-payment-widget/widget.js', import.meta.url), 'utf8');

class Element {
  value = '';
  textContent = '';
  className = '';
  hidden = false;
  disabled = false;
  checked = false;
  selected = false;
  listeners = new Map<string, (event: { preventDefault(): void }) => Promise<void>>();
  addEventListener(name: string, fn: (event: { preventDefault(): void }) => Promise<void>) { this.listeners.set(name, fn); }
  replaceChildren(...children: Element[]) { if (children.length) this.value = children[0].value; }
  append(..._children: Element[]) {}
}

async function harness(paymentError?: { code: string; details: unknown }) {
  const elements = new Map<string, Element>();
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const requests: { body: unknown; key: string }[] = [];
  let nextKey = 0;
  const fetch = vi.fn(async (url: string, options: { body?: string; headers: Record<string, string> }) => {
    if (url.endsWith('/context')) return { ok: true, json: async () => ({
      erp: { orderId: 11634, orderVersion: 12, finalAmount: '100000.00', debtAmount: '100000.00' },
      paymentSystems: [{ id: 14, name: 'Наличные Bitrix', isDefault: true }],
      serverDate: '2026-09-09', recentPayments: [], canCreate: true,
    }) };
    expect(url).toBe('../widget-api/payments');
    requests.push({ body: JSON.parse(options.body!), key: options.headers['Idempotency-Key'] });
    return paymentError
      ? { ok: false, json: async () => ({ error: { message: 'Bitrix24 payment request is invalid', ...paymentError } }) }
      : { ok: true, json: async () => ({ status: 'completed', message: 'Оплата создана' }) };
  });
  runInNewContext(source, {
    document: { body: { dataset: { widgetToken: 'synthetic-test-token' } }, getElementById: el, createElement: () => new Element() },
    fetch, crypto: { randomUUID: () => `test-key-${++nextKey}` }, Intl, window: { setTimeout },
  });
  await vi.waitFor(() => expect(el('notice').textContent).toBe('Готово к добавлению оплаты'));
  return { el, requests, submit: () => el('payment-form').listeners.get('submit')!({ preventDefault() {} }) };
}

describe('real Bitrix widget form -> canonical backend DTO', () => {
  it.each([
    ['5000', '5000.00'], ['50000', '50000.00'], ['5000.0', '5000.00'],
    ['5000.00', '5000.00'], ['5000,5', '5000.50'], [' 5000,50 ', '5000.50'],
    ['0.01', '0.01'], ['999999999999.99', '999999999999.99'],
  ])('submits %s as %s without rounding', async (value, canonical) => {
    const h = await harness(); h.el('amount').value = value;
    await h.submit();
    expect(h.requests).toHaveLength(1);
    expect(parseCreateWidgetPaymentInput(h.requests[0].body)).toMatchObject({
      amount: canonical, paymentDate: '2026-09-09', paySystemId: 14,
      expectedOrderVersion: 12, confirmOverpayment: false,
    });
    expect(h.el('submit').disabled).toBe(false);
  });

  it.each(['', '0', '0.00', '-1', '+1', '1e3', 'Infinity', 'NaN', '1.001', '1,000.00', '1 000', '1.', '01', '1000000000000'])
    ('rejects ambiguous/invalid amount %s locally', async (value) => {
      const h = await harness(); h.el('amount').value = value;
      await h.submit();
      expect(h.requests).toHaveLength(0);
      expect(h.el('notice').textContent).toContain('Сумма');
      expect(h.el('submit').disabled).toBe(false);
    });

  it('retains idempotency key after local validation and preserves explicit confirmation', async () => {
    const h = await harness(); h.el('amount').value = '12.345'; await h.submit();
    h.el('amount').value = '12'; h.el('confirmOverpayment').checked = true;
    await h.submit();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].key).toBe('test-key-1');
    expect(parseCreateWidgetPaymentInput(h.requests[0].body).confirmOverpayment).toBe(true);
  });

  it('shows a Russian field error without echoing raw validation data', async () => {
    const h = await harness({ code: 'VALIDATION_ERROR', details: { errors: [{ field: 'paymentDate', message: 'synthetic-private-value' }] } });
    h.el('amount').value = '5000.00'; await h.submit();
    expect(h.el('notice').textContent).toContain('Дата оплаты');
    expect(h.el('notice').textContent).not.toContain('synthetic-private-value');
    expect(h.el('submit').disabled).toBe(false);
  });
});
