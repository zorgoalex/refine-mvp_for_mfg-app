import { describe, expect, it } from 'vitest';
import { matchReply, renderReply, validateReply, replyVariables } from './whatsapp-template';

describe('personal reply templates', () => {
  const rule = { matchMode: 'pattern_exact' as const, keywords: ['Заказ {order_number:number} готов'] };
  it('extracts digits without losing zeros and ignores case/extra spaces', () => {
    expect(matchReply(rule, ' ЗАКАЗ  002222\nГотов ')).toEqual({ order_number: '002222' });
    expect(matchReply(rule, 'Заказ abc готов')).toBeNull();
    expect(matchReply(rule, 'Заказ 222 готов сегодня')).toBeNull();
  });
  it('matches fragments and preserves captured spelling', () => {
    expect(matchReply({ matchMode: 'pattern_contains', keywords: ['Клиент {name:text} готов'] }, 'Ответ: Клиент Иван Петров готов!'))
      .toEqual({ name: 'Иван Петров' });
    expect(matchReply({ matchMode: 'pattern_exact', keywords: ['{name:word}: {id:number}'] }, 'Иван: 001')).toEqual({ name: 'Иван', id: '001' });
  });
  it('preserves legacy matching and literal regex punctuation', () => {
    expect(matchReply({ matchMode: 'contains_any', keywords: ['ГОТОВ'] }, 'не готов')).toEqual({});
    expect(matchReply({ matchMode: 'exact_any', keywords: ['ГОТОВ'] }, ' готов ')).toEqual({});
    expect(matchReply({ matchMode: 'pattern_exact', keywords: ['(Заказ) {id:number}.'] }, '(заказ) 5.')).toEqual({ id: '5' });
  });
  it.each(['{a:regex}', '{a:number}{b:word}', '{a:word} {a:word}', '{counter:number}', '{__proto__:word}', '{bad}', 'x }'])('rejects malformed or ambiguous pattern %s', pattern => {
    expect(() => validateReply({ matchMode: 'pattern_exact', keywords: [pattern] }, 'ok', 'text')).toThrow();
  });
  it('requires every alternative to provide every response variable', () => {
    expect(() => validateReply({ ...rule, keywords: [...rule.keywords, 'Готово'] }, '{order_number}', 'template')).toThrow();
    expect(() => validateReply(rule, '{missing}', 'template')).toThrow();
    expect(() => validateReply(rule, '{broken', 'template')).toThrow();
  });
  it('renders once, does not recursively interpolate captures, uses ERP timezone', () => {
    const date = new Date('2026-09-21T21:30:00Z');
    expect(renderReply('{name} {{literal}} {current_date} {current_time} {counter}', 'template', { name: '{counter}' }, date, '7'))
      .toBe('{counter} {literal} 22.09.2026 02:30 7');
    expect(renderReply('{unknown}', 'text', {}, date, '7')).toBe('{unknown}');
    expect(replyVariables('{{literal}} {counter}')).toEqual(['counter']);
  });
  it('rejects missing fields, excessive output and excessive input', () => {
    expect(() => renderReply('{missing}', 'template', {}, new Date(), '1')).toThrow();
    expect(() => renderReply('{x}{x}', 'template', { x: 'a'.repeat(3000) }, new Date(), '1')).toThrow();
    expect(() => matchReply(rule, 'a'.repeat(4097))).toThrow();
  });
});
