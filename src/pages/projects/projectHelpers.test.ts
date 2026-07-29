import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canMergeInto, formatProjectRow } from './projectHelpers';

describe('canMergeInto', () => {
  it('rejects self and different client, accepts same-client other project', () => {
    expect(canMergeInto({ projectId: 1, clientId: 2 }, { projectId: 1, clientId: 2 })).toBe(false);
    expect(canMergeInto({ projectId: 1, clientId: 2 }, { projectId: 3, clientId: 9 })).toBe(false);
    expect(canMergeInto({ projectId: 1, clientId: 2 }, { projectId: 3, clientId: 2 })).toBe(true);
  });
});

describe('formatProjectRow', () => {
  it('shapes display fields for client, counts and sums', () => {
    expect(formatProjectRow({
      projectId: 9,
      code: 'FK26',
      name: 'Фасады июль',
      clientId: 44,
      clientName: 'ООО Ромашка',
      notes: null,
      version: 3,
      ordersCount: 12,
      totalFinalAmount: '12345.5',
      totalPaidAmount: null,
    })).toEqual({
      key: 9,
      projectId: 9,
      code: 'FK26',
      name: 'Фасады июль',
      clientLabel: 'ООО Ромашка',
      ordersCount: 12,
      ordersCountLabel: '12',
      totalFinalAmountLabel: '12 345,50',
      totalPaidAmountLabel: '0,00',
    });
  });
});

describe('projects pages source guards', () => {
  const listSource = readFileSync(fileURLToPath(new URL('./ProjectsList.tsx', import.meta.url)), 'utf8');
  const showSource = readFileSync(fileURLToPath(new URL('./ProjectShow.tsx', import.meta.url)), 'utf8');

  it('list page wires search, client filter and navigation', () => {
    expect(listSource).toContain('projectsApi.list');
    expect(listSource).toContain('Код');
    expect(listSource).toContain('Имя');
    expect(listSource).toContain('Клиент');
    expect(listSource).toContain('Заказов');
    expect(listSource).toContain('Сумма');
    expect(listSource).toContain('Оплачено');
    expect(listSource).toContain("navigate(`/projects/show/${record.projectId}`)");
  });

  it('show page wires save, merge and order links', () => {
    expect(showSource).toContain('projectsApi.update');
    expect(showSource).toContain('projectsApi.merge');
    expect(showSource).toContain('expectedVersion: project.version');
    expect(showSource).toContain('crypto.randomUUID()');
    expect(showSource).toContain('Сохранить');
    expect(showSource).toContain('Объединить с…');
    expect(showSource).toContain('/orders/show/${');
    expect(showSource).toContain('OrderDeletedTag');
    expect(showSource).toContain('orderDeletedReferenceClassName(row.deleteFlag)');
  });
});
