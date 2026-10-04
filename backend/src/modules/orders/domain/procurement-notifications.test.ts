import { describe, expect, it } from 'vitest';
import { addUnallocatedPage, almatyTime, digestText, isDigestDue, unallocatedDigestText } from './procurement-notifications';

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

  it('daily unallocated summary: counts, lines, older than 7 days, three oldest; empty → none', () => {
    const page = [
      { number: 'A-1', docDate: '2026-09-10', supplierName: 'Mirtov TOO', lines: 2 },
      { number: 'A-2', docDate: '2026-09-11', supplierName: null, lines: 1 },
      { number: 'A-3', docDate: '2026-09-20', supplierName: 'SAFA ИП', lines: 4 },
      { number: 'A-4', docDate: '2026-09-29', supplierName: 'X', lines: 1 },
    ];
    // Порции складываются: 3 + 1 документ.
    let totals = addUnallocatedPage({ documents: 0, lines: 0, old: 0, oldest: [] }, page.slice(0, 3), '2026-09-25');
    totals = addUnallocatedPage(totals, page.slice(3), '2026-09-25');
    expect(totals).toEqual({ documents: 4, lines: 8, old: 3, oldest: [
      { number: 'A-1', docDate: '2026-09-10', supplierName: 'Mirtov TOO' },
      { number: 'A-2', docDate: '2026-09-11', supplierName: null },
      { number: 'A-3', docDate: '2026-09-20', supplierName: 'SAFA ИП' },
    ] });
    expect(unallocatedDigestText(totals, '2026-10-02')).toEqual({
      title: 'Нераспределённые поступления на 02.10.2026',
      message: 'Не распределены поступления 1С: 4 (строк — 8), из них старше 7 дней — 3. Самые старые: № A-1 от 10.09.2026 (Mirtov TOO), № A-2 от 11.09.2026, № A-3 от 20.09.2026 (SAFA ИП). Подробности — экран снабжения, «Приходы».',
    });
    const fresh = addUnallocatedPage({ documents: 0, lines: 0, old: 0, oldest: [] }, page.slice(3), '2026-09-25');
    expect(unallocatedDigestText(fresh, '2026-10-02')!.message).toBe('Не распределены поступления 1С: 1 (строк — 1). Поступления: № A-4 от 29.09.2026 (X). Подробности — экран снабжения, «Приходы».');
    expect(unallocatedDigestText({ documents: 0, lines: 0, old: 0, oldest: [] }, '2026-10-02')).toBeNull();
    // Граница: ровно 7 дней (02.10 − 25.09) — ещё не «старше 7 дней».
    const boundary = addUnallocatedPage({ documents: 0, lines: 0, old: 0, oldest: [] },
      [{ number: 'B-1', docDate: '2026-09-25', supplierName: null, lines: 1 }, { number: 'B-2', docDate: '2026-09-24', supplierName: null, lines: 1 }], '2026-09-25');
    expect(boundary.old).toBe(1);
  });
});
