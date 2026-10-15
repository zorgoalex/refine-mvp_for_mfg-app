import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clientNotesWithoutErpLines } from './bitrix24-client-notes';

// Shared with the SQL cleanup of production notes: both must give the same result for every case.
const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, 'bitrix24-client-notes.fixtures.json'), 'utf8'),
) as Array<{ input: string; expected: string | null }>;

describe('clientNotesWithoutErpLines', () => {
  it('drops the ERP service lines appended for Bitrix24', () => {
    expect(clientNotesWithoutErpLines('ERP ID клиента: 2581')).toBeNull();
    expect(clientNotesWithoutErpLines('Звонить после 18:00\nСтатус ERP: неактивен\nERP ID клиента: 10'))
      .toBe('Звонить после 18:00');
  });

  it('cleans a comment that came back wrapped in Bitrix24 BB-code (production client 2550)', () => {
    expect(clientNotesWithoutErpLines('[p]\nERP ID клиента - 2550\n[/p]\nERP ID клиента: 2550')).toBeNull();
    expect(clientNotesWithoutErpLines('[p]ТОО "Тест"[br]вторая строка[/p]\nERP ID клиента: 7'))
      .toBe('ТОО "Тест"\nвторая строка');
  });

  it('removes repeated service lines and keeps the client text once', () => {
    expect(clientNotesWithoutErpLines('Заметка\nERP ID клиента: 5\nERP ID клиента: 5\nERP ID клиента: 5'))
      .toBe('Заметка');
  });

  it('keeps client text that only mentions ERP, single blank lines and quotes', () => {
    expect(clientNotesWithoutErpLines('  первая  \n\n\n\nвторая "в кавычках" \\ ERP ID клиента: 5 тоже'))
      .toBe('первая\n\nвторая "в кавычках" \\ ERP ID клиента: 5 тоже');
  });

  it.each(fixtures)('shared fixture %#', ({ input, expected }) => {
    expect(clientNotesWithoutErpLines(input)).toBe(expected);
  });

  it('returns null for empty or non-string input', () => {
    expect(clientNotesWithoutErpLines(null)).toBeNull();
    expect(clientNotesWithoutErpLines(undefined)).toBeNull();
    expect(clientNotesWithoutErpLines(42)).toBeNull();
    expect(clientNotesWithoutErpLines(' \r\n [p][/p] ')).toBeNull();
  });
});
