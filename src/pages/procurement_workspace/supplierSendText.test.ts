import { describe, expect, it } from 'vitest';
import fixtures from '../../../backend/src/modules/whatsapp/order-send/supplier-send-text.fixtures.json';
import { SUPPLIER_MESSAGE_MAX, SUPPLIER_TEXT_MAX, normalizeSupplierText, splitSupplierText, supplierTextProblem } from './supplierSendText';

const textOf = (item: { pieces: Array<{ text: string; repeat: number }>; join: string }) =>
  item.pieces.map((piece) => piece.text.repeat(piece.repeat)).join(item.join);

// The same cases as the backend split: the hint «уйдёт N сообщений» must agree with what the backend sends.
describe('supplier text as WhatsApp messages (port of the backend split)', () => {
  it.each(fixtures.cases)('$name', (item) => {
    const messages = splitSupplierText(textOf(item));
    expect(messages.map((message) => message.length)).toEqual(item.lengths);
    expect(messages.every((message) => message.length <= SUPPLIER_MESSAGE_MAX)).toBe(true);
  });

  it('says why a text cannot be sent', () => {
    expect(supplierTextProblem(' \n')).toBe('empty');
    expect(supplierTextProblem('а'.repeat(SUPPLIER_TEXT_MAX + 1))).toBe('too_long');
    expect(supplierTextProblem('Тест\u0000')).toBe('control_characters');
    expect(supplierTextProblem('Тест\tстрока\nещё')).toBeNull();
    expect(normalizeSupplierText('a\r\nb\rc')).toBe('a\nb\nc');
  });
});
