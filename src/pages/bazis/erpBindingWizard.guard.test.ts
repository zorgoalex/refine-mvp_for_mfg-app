import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Node-env без jsdom: интеграцию взаимосвязанных полей шага «Привязка»
 * (клиент ↔ ERP-проект ↔ ERP-заказ) фиксируем source-text guard'ами;
 * сама логика сужения — в pure-тестах erpBindingFilters.test.ts.
 */
const wizard = readFileSync(new URL('./ImportWizardModal.tsx', import.meta.url), 'utf8');

describe('import wizard erp-binding guards', () => {
  it('erp mode wires all three interlinked pick handlers', () => {
    expect(wizard).toContain('nextBindingOnClientPick(');
    expect(wizard).toContain('nextBindingOnProjectPick(');
    expect(wizard).toContain('nextBindingOnOrderPick(');
  });

  it('orders are server-filtered by client/project/search', () => {
    expect(wizard).toMatch(/ordersApi\.list\(\{\s*clientId: erpClientId,\s*projectId: selectedProjectId,\s*search:/);
  });

  it('order search input does not use client-side option filtering', () => {
    expect(wizard).toContain('filterOption={false}');
    expect(wizard).toContain('onSearch={(value) => setErpOrderSearch(value)}');
  });
});
