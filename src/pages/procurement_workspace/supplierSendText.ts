/**
 * How the text of a supplier request goes to WhatsApp — a port of the backend rules
 * (backend/src/modules/whatsapp/order-send/supplier-send-text.ts, the same fixture cases) for the hint
 * «уйдёт N сообщений» and the button state. The backend decides; this only explains.
 */

export const SUPPLIER_TEXT_MAX = 20_000;
export const SUPPLIER_MESSAGE_MAX = 4096;
export const SUPPLIER_MESSAGES_MAX = 8;

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/u;

export type SupplierTextProblem = 'empty' | 'too_long' | 'control_characters' | 'too_many_messages';

export function normalizeSupplierText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n');
}

export function supplierTextProblem(text: string): SupplierTextProblem | null {
  if (text.trim() === '') return 'empty';
  if (text.length > SUPPLIER_TEXT_MAX) return 'too_long';
  if (CONTROL.test(text)) return 'control_characters';
  return splitSupplierText(text).length > SUPPLIER_MESSAGES_MAX ? 'too_many_messages' : null;
}

/** Messages of at most 4096 characters: cut at line breaks, a longer line — at a space, else by characters. */
export function splitSupplierText(text: string, limit = SUPPLIER_MESSAGE_MAX): string[] {
  const messages: string[] = [];
  let current: string | null = null;
  const flush = () => {
    if (current !== null) {
      const message = current.replace(/^\n+|\n+$/g, '');
      if (message.trim() !== '') messages.push(message);
    }
    current = null;
  };
  for (const line of text.split('\n')) {
    for (const piece of cutLine(line, limit)) {
      if (current === null) current = piece;
      else if (current.length + 1 + piece.length <= limit) current = `${current}\n${piece}`;
      else { flush(); current = piece; }
    }
  }
  flush();
  return messages;
}

function cutLine(line: string, limit: number): string[] {
  if (line.length <= limit) return [line];
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    const space = rest.lastIndexOf(' ', limit);
    if (space > 0) {
      pieces.push(rest.slice(0, space));
      rest = rest.slice(space + 1);
      continue;
    }
    let end = limit;
    const code = rest.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    pieces.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}
