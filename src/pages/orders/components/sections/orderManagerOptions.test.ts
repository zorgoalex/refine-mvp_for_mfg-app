import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { can } from '../../../../utils/permissions';
import { ORDER_MANAGER_CHANGE_PERMISSION, orderManagerOptions } from './orderManagerOptions';

const candidates = [{ value: 3, label: 'admin', sortOrder: 0 }, { value: 91, label: 'ДизайнерТест', sortOrder: 1 }];
const form = readFileSync(resolve(__dirname, 'OrderBasicInfo.tsx'), 'utf8');

describe('«Менеджер» of the order form', () => {
  it('lists ERP users; the current manager outside the candidates keeps the name read with the order', () => {
    expect(orderManagerOptions(candidates, 91, 'ДизайнерТест')).toBe(candidates);
    expect(orderManagerOptions(candidates, null, null)).toBe(candidates);
    expect(orderManagerOptions(candidates, 77, 'Бывший менеджер').at(-1)).toEqual({ value: 77, label: 'Бывший менеджер', sortOrder: -1 });
    expect(orderManagerOptions([], 77, null)).toEqual([{ value: 77, label: 'Пользователь 77', sortOrder: -1 }]);
  });

  it('only a user with orders.manager.change may choose another manager', () => {
    expect(ORDER_MANAGER_CHANGE_PERMISSION).toBe('orders.manager.change');
    expect(can(ORDER_MANAGER_CHANGE_PERMISSION, { permissions: ['orders.update'] } as never)).toBe(false);
    expect(can(ORDER_MANAGER_CHANGE_PERMISSION, { permissions: ['orders.update', 'orders.manager.change'] } as never)).toBe(true);
    expect(form).toContain('const canChangeManager = can(ORDER_MANAGER_CHANGE_PERMISSION, currentUser);');
    const select = form.slice(form.indexOf('label="Менеджер"'), form.indexOf('</Select>', form.indexOf('label="Менеджер"')));
    expect(select).toContain('disabled={!canChangeManager}');
    expect(select).toContain('allowClear={canChangeManager}');
    expect(select).toContain('options={managerOptions.map(');
    expect(select).not.toContain('resolvedEmployeeSelectProps');
  });

  it('a failed candidate request is shown with a retry, not as an empty list (Hasura-reference mode)', () => {
    expect(form).toContain('.catch(() => { if (!controller.signal.aborted) setManagerOptionsFailed(true); });');
    expect(form).toContain('}, [useBackendReferences, packerMode, managerOptionsAttempt]);');
    expect(form).toContain('onClick={retryManagerOptions}>Повторить</Button>');
    expect(form).not.toContain('setManagerOptionsFromApi([])');
  });
});
