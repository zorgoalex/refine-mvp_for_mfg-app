import { describe, expect, it } from 'vitest';
import { emptyConfiguration, extractReferences, matches, matchRules, messageKey, parseConfiguration, parseWahaGroup } from './inbound-signals.domain';

describe('Inbound signal normalization and templates', () => {
  const envelope = { event: 'message', session: 'erp', payload: { id: 'message-1', from: '123@g.us',
    participant: '456@lid', fromMe: false, timestamp: 1789980000, body: 'Заказ 1254 готов' } };
  it('keeps group sender distinct from group and ignores direct and own messages', () => {
    expect(parseWahaGroup(envelope, 'erp')).toMatchObject({ sender: '456@lid', chatId: '123@g.us' });
    expect(parseWahaGroup({ ...envelope, payload: { ...envelope.payload, from: '123@lid' } }, 'erp')).toBeNull();
    expect(parseWahaGroup({ ...envelope, payload: { ...envelope.payload, fromMe: true } }, 'erp')).toBeNull();
    expect(parseWahaGroup(envelope, 'another')).toBeNull();
  });
  it('reads a caption without fetching an attachment', () => {
    expect(parseWahaGroup({ ...envelope, payload: { ...envelope.payload, body: '', caption: 'Готов заказ 8', hasMedia: true } }, 'erp')?.text).toBe('Готов заказ 8');
  });
  it('deduplicates by message identity rather than delivery timestamp or text', () => {
    const message = parseWahaGroup(envelope, 'erp')!;
    expect(messageKey(message)).toBe(messageKey({ ...message, text: 'edited', sentAt: new Date() }));
    expect(messageKey(message)).not.toBe(messageKey({ ...message, connection: 'another' }));
  });
  it('supports Russian word boundaries and does not treat not-ready as ready', () => {
    expect(matches('Заказ ГОТОВ!', 'готов', 'phrase')).toBe(true);
    expect(matches('неготовый', 'готов', 'phrase')).toBe(false);
    const config = { ...emptyConfiguration, rules: [{ code: 'ready', name: 'Готов', sourceCodes: ['shop'], signalCode: 'ready',
      resolverCode: 'order', keywords: ['готов'], exclusions: ['не готов'], matchMode: 'phrase' as const, enabled: true, priority: 100 }] };
    expect(matchRules('Заказ 123 не готов', 'shop', config)).toHaveLength(0);
    expect(matchRules('Заказ 123 готов', 'shop', config)).toHaveLength(1);
    expect(matchRules('Заказ 123 готов', 'other', config)).toHaveLength(0);
  });
  it('extracts bounded configured references with literal prefixes', () => {
    const resolver = { code: 'order', name: 'Заказ', target: 'order_id' as const, prefixes: ['заказ', 'заказ ERP'], format: 'digits' as const };
    expect(extractReferences('Заказ №1254 готов; заказ ERP: 2001 готов', resolver)).toEqual(['1254', '2001']);
    expect(extractReferences('подзаказ 123', resolver)).toEqual([]);
    expect(extractReferences('заказ 123abc', resolver)).toEqual([]);
    expect(extractReferences('заказ 123', { ...resolver, prefixes: ['.*'] })).toEqual([]);
  });
  it('rejects dangling rules, duplicate source connections, and arbitrary template code', () => {
    expect(() => parseConfiguration({ ...emptyConfiguration, rules: [{ code: 'ready', name: 'Готов', sourceCodes: ['missing'],
      signalCode: 'ready', resolverCode: 'order', keywords: ['готов'], exclusions: [], matchMode: 'phrase', enabled: true, priority: 100 }] })).toThrow();
    const source = { code: 'shop', name: 'Цех', channel: 'whatsapp', connection: 'erp', chatId: '123@g.us', enabled: true };
    expect(() => parseConfiguration({ ...emptyConfiguration, sources: [source, { ...source, code: 'other' }] })).toThrow();
    expect(() => parseConfiguration({ ...emptyConfiguration, resolvers: [{ code: 'order', name: 'Заказ', target: 'sql', prefixes: ['заказ'], format: 'digits' }] })).toThrow();
  });
});
