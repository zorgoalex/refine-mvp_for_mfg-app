import { describe, expect, it } from 'vitest';
import fixtures from './supplier-send-text.fixtures.json';
import { SUPPLIER_MESSAGE_MAX, SUPPLIER_TEXT_MAX, normalizeSupplierText, splitSupplierText, supplierTextProblem } from './supplier-send-text';

const textOf = (item: { pieces: Array<{ text: string; repeat: number }>; join: string }) =>
  item.pieces.map((piece) => piece.text.repeat(piece.repeat)).join(item.join);

describe('the text of a supplier request as WhatsApp messages', () => {
  it.each(fixtures.cases)('$name', (item) => {
    const messages = splitSupplierText(textOf(item));
    expect(messages.map((message) => message.length)).toEqual(item.lengths);
    expect(messages.every((message) => message.length <= SUPPLIER_MESSAGE_MAX && message.trim() !== '')).toBe(true);
  });

  it('keeps every character of the lines and their order', () => {
    const text = Array.from({ length: 500 }, (_, index) => `${index + 1}. Тест позиция — ${index} листов`).join('\n');
    expect(splitSupplierText(text).join('\n')).toBe(text);
  });

  it('never cuts inside a surrogate pair', () => {
    for (const message of splitSupplierText(`a${'😀'.repeat(5000)}`)) expect(message).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/u);
  });

  it('says why a text cannot be sent', () => {
    expect(supplierTextProblem(' \n\t')).toBe('empty');
    expect(supplierTextProblem('а'.repeat(SUPPLIER_TEXT_MAX + 1))).toBe('too_long');
    expect(supplierTextProblem('Тест\u0000')).toBe('control_characters');
    expect(supplierTextProblem('Тест\tс табуляцией\nи строкой')).toBeNull();
    expect(supplierTextProblem('а'.repeat(SUPPLIER_TEXT_MAX))).toBeNull();
    expect(normalizeSupplierText('a\r\nb\rc')).toBe('a\nb\nc');
  });
});
