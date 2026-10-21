import { describe, expect, it } from 'vitest';
import { workbenchDeadlineLine, workbenchPaymentLine, workbenchTotalLine } from './workbenchOrderCardModel';

const now = new Date(2026, 9, 21, 10, 0);

describe('NewLine phone order card lines', () => {
  it('describes the deadline like the NewLine list does', () => {
    expect(workbenchDeadlineLine({ planned_completion_date: '2026-10-28' }, now)).toEqual({ text: 'до 28.10 · через 7 дн.', tone: 'neutral' });
    expect(workbenchDeadlineLine({ planned_completion_date: '2026-10-22' }, now)).toEqual({ text: 'до 22.10 · завтра', tone: 'warning' });
    expect(workbenchDeadlineLine({ planned_completion_date: '2026-10-19' }, now)).toEqual({ text: 'до 19.10 · просрочено 2 дн.', tone: 'danger' });
    expect(workbenchDeadlineLine({ planned_completion_date: '2026-10-19', issue_date: '2026-10-20' }, now)).toEqual({ text: 'до 19.10 · выдан', tone: 'neutral' });
    expect(workbenchDeadlineLine({}, now)).toBeNull();
  });

  it('derives the payment state from amounts and hides it without financial access', () => {
    expect(workbenchPaymentLine({ final_amount: 100, paid_amount: 100 }, true)).toEqual({ text: 'оплачен', tone: 'ready' });
    expect(workbenchPaymentLine({ final_amount: 100, paid_amount: 0 }, true)).toEqual({ text: 'не оплачен', tone: 'danger' });
    expect(workbenchPaymentLine({ final_amount: 60381, paid_amount: 30000 }, true)).toEqual({ text: 'остаток 30 381 ₸', tone: 'warning' });
    expect(workbenchPaymentLine({ final_amount: 100, paid_amount: 0 }, false)).toBeNull();
    expect(workbenchPaymentLine({ final_amount: 0, paid_amount: 0 }, true)).toBeNull();
    expect(workbenchTotalLine({ final_amount: 8446 }, true)).toBe('8 446 ₸');
    expect(workbenchTotalLine({ final_amount: 8446 }, false)).toBeNull();
  });
});
