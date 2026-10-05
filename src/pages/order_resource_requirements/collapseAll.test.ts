import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { resolveCollapseAll } from './list';

const rows = [{ orderId: 101 }, { orderId: 102 }, { orderId: 103 }];
const listSource = readFileSync(new URL('./list.tsx', import.meta.url), 'utf8');

describe('кнопка «Свернуть все»', () => {
  it('в «Сводке» сворачивает, пока на странице раскрыта хоть одна строка', () => {
    expect(resolveCollapseAll('summary', rows, [102], new Set())).toEqual({ collapse: true });
    expect(resolveCollapseAll('summary', rows, [], new Set())).toEqual({ collapse: false });
  });

  it('в «Сводке» не учитывает раскрытые строки с других страниц', () => {
    expect(resolveCollapseAll('summary', rows, [999], new Set())).toEqual({ collapse: false });
  });

  it('в «Материалах» сворачивает, пока есть хоть одна развёрнутая группа', () => {
    expect(resolveCollapseAll('materials', rows, [], new Set())).toEqual({ collapse: true });
    expect(resolveCollapseAll('materials', rows, [], new Set([101, 102]))).toEqual({ collapse: true });
    expect(resolveCollapseAll('materials', rows, [], new Set([101, 102, 103]))).toEqual({ collapse: false });
  });

  it('в «Панели» кнопки нет', () => {
    expect(resolveCollapseAll('panel', rows, [101], new Set())).toEqual({ collapse: false });
    expect(listSource).toContain("viewMode !== 'panel' && (");
  });

  it('кнопка показывает «Свернуть все» / «Развернуть все» и управляет обоими видами', () => {
    expect(listSource).toContain("'Свернуть все' : 'Развернуть все'");
    expect(listSource).toContain('setExpandedRowKeys(collapseAllState.collapse ? [] : allOrderIds)');
    expect(listSource).toContain('setCollapsedMaterialOrders(collapseAllState.collapse ? new Set(allOrderIds) : new Set())');
    expect(listSource).toContain('collapsed={collapsedMaterialOrders}');
  });
});
