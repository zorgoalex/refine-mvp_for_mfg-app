/**
 * The text of a supplier request as it goes to WhatsApp. The text comes from the window «Текст для поставщика»
 * (template + manual edits) and is sent as it is; a long one is split into several messages.
 * Pure functions: the frontend has a port of the split for the hint «уйдёт N сообщений»
 * (`src/pages/procurement_workspace/supplierSendText.ts`, the same fixture cases); the backend decides.
 */

/** The whole text of one send. */
export const SUPPLIER_TEXT_MAX = 20_000;
/** One WhatsApp message. */
export const SUPPLIER_MESSAGE_MAX = 4096;
export const SUPPLIER_MESSAGES_MAX = 8;

/** Anything but a line break and a tab (line endings are normalized to `\n` first). */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/u;

export type SupplierTextProblem = 'empty' | 'too_long' | 'control_characters' | 'too_many_messages';

/** `\r\n` and a lone `\r` become `\n`; nothing else changes. */
export function normalizeSupplierText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n');
}

/** Why the (normalized) text cannot be sent, or null. */
export function supplierTextProblem(text: string): SupplierTextProblem | null {
  if (text.trim() === '') return 'empty';
  if (text.length > SUPPLIER_TEXT_MAX) return 'too_long';
  if (CONTROL.test(text)) return 'control_characters';
  return splitSupplierText(text).length > SUPPLIER_MESSAGES_MAX ? 'too_many_messages' : null;
}

/**
 * Messages of at most 4096 characters, in order. A message ends at a line break; a single line longer than
 * a message is cut at a space, and one without spaces — by characters (never inside a surrogate pair).
 * Blank lines at the edges of a message are dropped; a message never is empty.
 */
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

/** A line as pieces that each fit a message (one piece for an ordinary line). */
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
    // No space to cut at: by characters, keeping a surrogate pair whole.
    let end = limit;
    const code = rest.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    pieces.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}
