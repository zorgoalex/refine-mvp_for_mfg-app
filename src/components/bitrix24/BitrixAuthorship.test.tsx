import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BitrixActorLabel, BitrixPaymentAuthorship } from './BitrixAuthorship';
import { OrderMetaBlock } from '../../pages/orders/components/sections/OrderMetaBlock';
import type { Bitrix24IncomingPayment } from '../../api/bitrix24Api';

vi.mock('../../query/orderLifecycleQueries', () => ({ useOne: () => { throw new Error('No users directory requests allowed'); } }));

describe('Bitrix authorship display', () => {
  it('escapes names, keeps source ID and labels ERP association separately', () => {
    const html = renderToStaticMarkup(<BitrixActorLabel actor={{ bitrixUserId: '7', displayName: '<script>bad</script>', erpUserId: 3, erpDisplayName: 'ERP User' }} />);
    expect(html).not.toContain('<script>');
    expect(html).toContain('Bitrix #7');
    expect(html).toContain('Сопоставлен ERP');
  });
  it('does not call paid-state actor the creator', () => {
    const html = renderToStaticMarkup(<BitrixPaymentAuthorship payment={{ source: 'native', authorship: { createdBy: null, paidBy: { bitrixUserId: '9', displayName: 'Actor' } } } as Bitrix24IncomingPayment} />);
    expect(html).toContain('Bitrix не передал автора');
    expect(html).toContain('Статус оплаты изменил (Bitrix)');
  });
  it('shows technical service author without users lookup or source substitution', () => {
    const html = renderToStaticMarkup(<OrderMetaBlock record={{ created_by: 86, edited_by: 3, __backendOrder: { header: { created_by_label: 'Сервис интеграции ERP', edited_by_label: 'ERP User' } } }} />);
    expect(html).toContain('Создал в ERP');
    expect(html).toContain('Сервис интеграции ERP');
    expect(html).toContain('ERP User');
  });
});
