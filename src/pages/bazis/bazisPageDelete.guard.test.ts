import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Node-тест-окружение без jsdom: кнопку удаления Базис-проекта фиксируем
 * source-text guard'ами (паттерн репо для страничного UI).
 *
 * Контракт: удаление жёсткое, за Popconfirm, зовёт bazisApi.deleteProject,
 * недоступно без bazis.manage и подсвечивает гейт «есть созданные заказы»
 * (backend в этом случае отвечает 409 BAZIS_PROJECT_HAS_ORDERS).
 */
const source = readFileSync(new URL('./BazisPage.tsx', import.meta.url), 'utf8');

describe('BazisPage delete-project guards', () => {
  it('wires a Popconfirm delete action to bazisApi.deleteProject', () => {
    expect(source).toContain('Popconfirm');
    expect(source).toContain('bazisApi.deleteProject(');
  });

  it('disables delete without bazis.manage and when orders exist', () => {
    expect(source).toMatch(/disabled=\{!canManage \|\| record\.linkedOrderIds\.length > 0\}/);
  });

  it('reloads the list after successful delete', () => {
    expect(source).toMatch(/deleteProject[\s\S]*?loadProjects/);
  });
});
