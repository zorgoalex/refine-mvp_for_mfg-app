import { describe, expect, it } from 'vitest';
import { almatyTime, digestText, isDigestDue, unallocatedText } from './procurement-notifications';

describe('procurement scheduled notifications — pure logic (§5.7)', () => {
  it('digest is due from the configured Almaty time', () => {
    // 03:00 UTC = 08:00 Asia/Almaty (UTC+5).
    expect(almatyTime(new Date('2026-10-02T03:00:00Z'))).toBe('08:00');
    expect(isDigestDue(new Date('2026-10-02T03:29:00Z'), '08:30')).toBe(false);
    expect(isDigestDue(new Date('2026-10-02T03:30:00Z'), '08:30')).toBe(true);
    expect(isDigestDue(new Date('2026-10-02T15:00:00Z'), '08:30')).toBe(true);
  });

  it('digest text carries aggregates only; an empty digest is not created', () => {
    expect(digestText({ uncovered: 0, urgent: 0, deficitM2: 0, deficitLm: 0 }, '2026-10-02')).toBeNull();
    const text = digestText({ uncovered: 12, urgent: 7, deficitM2: 44.99, deficitLm: 3.5 }, '2026-10-02')!;
    expect(text.title).toBe('Сводка закупа на 02.10.2026');
    expect(text.message).toContain('Не покрыто позиций: 12, из них срочно: 7.');
    expect(text.message).toContain('44,99 м²');
    expect(text.message).toContain('3,5 пог. м');
    expect(digestText({ uncovered: 1, urgent: 0, deficitM2: 0, deficitLm: 0 }, '2026-10-02')!.message).not.toContain('Дефицит');
  });

  it('unallocated text: document number, date, supplier and line count — no orders', () => {
    expect(unallocatedText({ number: 'НФНФ-1', docDate: '2026-09-28', supplierName: 'AGER-2005 TOO', lines: 3 })).toEqual({
      title: 'Поступление не распределено',
      message: 'Поступление № НФНФ-1 от 28.09.2026 (AGER-2005 TOO): не распределено строк — 3.',
    });
    expect(unallocatedText({ number: 'X', docDate: '2026-09-28', supplierName: null, lines: 1 }).message).not.toContain('(');
  });
});
