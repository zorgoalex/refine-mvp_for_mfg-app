import { describe, expect, it } from 'vitest';
import { emptyConfiguration, extractReferenceList, planSignalGroups, projectVisibleText, type SignalConfiguration, type SignalPlan } from './inbound-signals.domain';

const source = { code: 'shop', name: 'Цех', channel: 'whatsapp' as const, connection: 'erp', chatId: '123@g.us', enabled: true };
const resolver = { code: 'order', name: 'Заказ', target: 'order_name' as const, prefixes: ['заказ'], format: 'digits' as const };
const rule = (code: string, signalCode: string, keywords: string[], extra: Partial<SignalConfiguration['rules'][number]> = {}) => ({
  code, name: code, sourceCodes: ['shop'], signalCode, resolverCode: 'order', keywords, exclusions: [], matchMode: 'phrase' as const,
  enabled: true, priority: 100, ...extra });
const config: SignalConfiguration = { ...emptyConfiguration, sources: [source],
  signals: [{ code: 'ready', name: 'Готов' }, { code: 'taken', name: 'Забрал' }], resolvers: [resolver],
  rules: [rule('ready', 'ready', ['готов', 'готовы'], { exclusions: ['не готов'] }), rule('taken', 'taken', ['забрал'])] };

const groups = (text: string, cfg = config) => {
  const plan: SignalPlan = planSignalGroups(text, 'shop', cfg);
  return plan.kind === 'legacy' ? 'legacy' : plan.groups.map(g => `${g.signalCode}:${g.references.map(r => r.reference).join(',')}`);
};

describe('several signals in one message', () => {
  it('the examples of the user: one signal per order', () => {
    expect(groups('Заказчик забрал заказ \n3087\nЗаказчик забрал заказ 3084')).toEqual(['taken:3087', 'taken:3084']);
    expect(groups('Заказ 3087 готов\nЗаказ 3094 готов\nЗаказ 3092 готов')).toEqual(['ready:3087', 'ready:3094', 'ready:3092']);
  });

  it('live messages of stage', () => {
    expect(groups('Заказчик забрал заказ \n3065\n3043')).toEqual(['taken:3065,3043']);
    expect(groups('заказ 3046 готов\nЗаказ 3051 готов')).toEqual(['ready:3046', 'ready:3051']);
    // A footer keyword line takes the number lines above it.
    expect(groups('Заказ 3047\nЗаказ 3046\nЗаказ 3051\nГотовы')).toEqual(['ready:3047,3046,3051']);
  });

  it('several numbers in one line (decision of the user)', () => {
    expect(groups('Заказ 3046, 3051 готов')).toEqual(['ready:3046,3051']);
    expect(groups('заказ 3053 и 3062 готовы')).toEqual(['ready:3053,3062']);
    expect(extractReferenceList('Заказ 3046, 3051 и 3052 готов', resolver)).toEqual(['3046', '3051', '3052']);
  });

  it('a line with other words closes the group; its numbers never inherit the action', () => {
    expect(groups('Заказ 3053 готов\nЗаказ 3062 әлі дайын емес')).toEqual(['ready:3053']);
    expect(groups('Заказ 3053 готов\nРазмер в мм:\n3062')).toEqual(['ready:3053']);
    expect(groups('Заказ 3053 готов\n2800×550--4шт\n3062')).toEqual(['ready:3053']);
    expect(groups('Заказ 3053 готов\n@69393853767794 3062')).toEqual(['ready:3053']);
  });

  it('bare numbers count only under a keyword line that names the prefix (or next to prefixed numbers)', () => {
    expect(groups('Готов\n3062')).toEqual(['ready:']);
    expect(groups('Заказ готов\n3062\n3063')).toEqual(['ready:3062,3063']);
    expect(groups('Готовы\nЗаказ 3062\n3063')).toEqual(['ready:3062,3063']);
  });

  it('messages without a keyword stay non-signals; one line with one number takes the old path', () => {
    expect(groups('3067\n3074 хдф нет')).toBe('legacy');
    expect(groups('БР-81-МДФ деген атпен 2лист МДФ жібердім\n3076\n3078\n3074 заказдар.')).toBe('legacy');
    expect(groups('Заказ 3087 готов')).toBe('legacy');
    expect(groups('Заказ 3087\nготов')).toEqual(['ready:3087']);
  });

  it('keeps «exact» rules and keywords spanning lines on the old path', () => {
    const exact: SignalConfiguration = { ...config, rules: [rule('ready', 'ready', ['готов'], { matchMode: 'exact' })] };
    expect(groups('готов', exact)).toBe('legacy');
    const spanning: SignalConfiguration = { ...config, rules: [rule('taken', 'taken', ['забрал заказ'])] };
    expect(groups('Клиент забрал\nзаказ 3087', spanning)).toBe('legacy');
  });

  it('exclusions still exclude, per message and per line', () => {
    expect(groups('Заказ 3087 не готов\nЗаказ 3094 не готов')).toBe('legacy');
    expect(groups('Заказ 3087 готов\nЗаказ 3094 не готов')).toBe('legacy');
  });

  it('caps the references of one message', () => {
    const many = Array.from({ length: 21 }, (_, i) => `Заказ ${3000 + i} готов`).join('\n');
    const plan = planSignalGroups(many, 'shop', config);
    expect(plan.kind === 'split' && plan.tooMany).toBe(true);
  });

  it('the fragment shown without the resolve right keeps only the numbers of its own order', () => {
    const refs = [{ resolverCode: 'order', reference: '3053', orderId: '11' }, { resolverCode: 'order', reference: '3062', orderId: '12' }];
    expect(projectVisibleText('Заказ 3053, 3062 готов', refs, '11')).toBe('Заказ 3053, … готов');
    expect(projectVisibleText('Заказ 3053, 3062 готов', refs, '99')).toBe('Заказ …, … готов');
    expect(projectVisibleText('Заказ 3053, 3062 готов', refs, null)).toBe('Заказ …, … готов');
  });

  it('review r1: no other number reaches the fragment — unaccepted lines, full-width digits, stray numbers', () => {
    const plan = planSignalGroups('Заказ 3053 готов\n3062', 'shop', config);
    expect(plan.kind === 'split' && plan.groups.map(g => [g.text, g.references.map(r => r.reference)])).toEqual([['Заказ 3053 готов', ['3053']]]);
    const refs = [{ resolverCode: 'order', reference: '3053', orderId: '11' }, { resolverCode: 'order', reference: '3062', orderId: '12' }];
    expect(projectVisibleText('Заказ 3053, ３０６２ готов', refs, '11')).toBe('Заказ 3053, … готов');
    expect(projectVisibleText('Заказ №3053 готов, 3070 тоже', refs.slice(0, 1), '11')).toBe('Заказ №3053 готов, … тоже');
    expect(projectVisibleText('ЗАКАЗ ３０５３ готов', refs, '11')).toBe('ЗАКАЗ ３０５３ готов');
  });

  it('review r2: code references are masked whatever form their letters take', () => {
    const refs = [{ resolverCode: 'project', reference: 'aa', orderId: '11' }, { resolverCode: 'project', reference: 'май', orderId: '12' }];
    expect(projectVisibleText('Проект AA, МАИ\u0306 готов', refs, '11')).toBe('Проект AA, … готов');
    expect(projectVisibleText('Проект ＡＡ, МАЙ готов', refs, '11')).toBe('Проект ＡＡ, … готов');
    // A context-dependent fold (final sigma) cannot be mapped back: everything is hidden.
    expect(projectVisibleText('Проект AA, ΟΔΟΣ готов', refs, '11')).toBe('…');
    const bb = [refs[0], { resolverCode: 'project', reference: 'bb', orderId: '12' }];
    expect(projectVisibleText('Проект AA, ⒷⒷ готов ΟΔΟΣ', bb, '11')).toBe('…');
    expect(projectVisibleText('Проект AA, ⒷⒷ готов', bb, '11')).toBe('Проект AA, … готов');
  });

  it('review r1: a number line ending a sentence keeps its number (classification = extraction)', () => {
    expect(groups('Заказ 3053 готов\nЗаказ 9999.')).toEqual(['ready:3053,9999']);
    expect(groups('Готов заказ 3053.\nГотов заказ 3054.')).toEqual(['ready:3053', 'ready:3054']);
    expect(extractReferenceList('заказ 12.10 готов', resolver)).toEqual([]);
    expect(extractReferenceList('заказ 3087.5 готов', resolver)).toEqual([]);
  });
});
