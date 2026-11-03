import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildKbarRecordActions, kbarRecordSearchTerm } from './workbenchKbarSearch';

describe('NewLine Ctrl+K: orders and clients in the quick switcher', () => {
  it('searches only from two characters, trimmed', () => {
    expect(kbarRecordSearchTerm('')).toBeNull();
    expect(kbarRecordSearchTerm(' 3 ')).toBeNull();
    expect(kbarRecordSearchTerm(' 30 ')).toBe('30');
  });

  it('turns found records into actions that open the order card or the client card', () => {
    const opened: string[] = [];
    const actions = buildKbarRecordActions(
      '309',
      [{ orderId: 11845, orderName: '3090', clientName: 'Нуржан Камзин', orderStatusName: 'Новый' }, { orderId: 7, orderName: '3091' }],
      [{ clientId: 42, clientName: 'Иван 309' }],
      (path) => opened.push(path),
    );
    expect(actions.map((action) => [action.name, action.subtitle, action.section.name])).toEqual([
      ['Заказ 3090', 'Нуржан Камзин · Новый', 'Заказы'],
      ['Заказ 3091', undefined, 'Заказы'],
      ['Иван 309', 'Клиент', 'Клиенты'],
    ]);
    // the server already matched them: the term is a keyword so KBar's fuzzy filter keeps them
    expect(actions.every((action) => action.keywords === '309')).toBe(true);
    actions.forEach((action) => action.perform());
    expect(opened).toEqual(['/orders/show/11845', '/orders/show/7', '/clients/show/42']);
  });

  it('keeps the built-in KBar actions and is mounted only in NewLine, with menu rights per section', () => {
    const layout = readFileSync('src/ui-evolution/shell/EvolutionWorkspaceLayout.tsx', 'utf8');
    expect(layout).toContain("{variant === 'workbench' ? <WorkbenchKbarRecordSearch /> : null}");
    const search = readFileSync('src/ui-evolution/shell/WorkbenchKbarRecordSearch.tsx', 'utf8');
    expect(search).toContain("featureFlags.useBackendOrdersRead && canViewNavigation('orders_view')");
    expect(search).toContain("canViewNavigation('clients')");
    expect(search).toContain('useRegisterActions(actions, [actions]);');
    expect(search).toContain('if (!cancelled) setFound({ term, orders, clients });');
  });
});
