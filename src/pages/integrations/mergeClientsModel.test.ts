import { describe, expect, it } from 'vitest';
import type { DuplicateMemberDetail } from '../../api/integrationDuplicatesApiTypes';
import {
  canConfirmMerge, canMergeCase, confirmText, countLines, defaultSurvivorId, memberOrderCount, mergeErrorInfo,
  mergeableMembers, obstaclesFromDetails, resolveMergedId, warningLabel,
} from './mergeClientsModel';

const member = (over: Partial<DuplicateMemberDetail>): DuplicateMemberDetail => ({
  system: 'erp', entityKind: 'client', recordKey: '1', erpEntityId: 1, name: 'А', joinedAt: '2026-10-01T00:00:00Z',
  leftAt: null, recordCreatedAt: '2026-10-01T00:00:00Z', author: null, authorExternal: null, via: 'erp_manual',
  facts: [], matchedValues: [], ...over,
});
const card = (members: DuplicateMemberDetail[], over = {}) => ({ entityKind: 'client' as const, status: 'open' as const, members, ...over });

describe('merge clients model', () => {
  it('lists only active ERP client members of an open client case', () => {
    const c = card([
      member({ erpEntityId: 1 }),
      member({ erpEntityId: 2, recordKey: '2' }),
      member({ erpEntityId: 3, recordKey: '3', leftAt: '2026-10-02T00:00:00Z' }),
      member({ system: 'onec', erpEntityId: null, recordKey: 'x' }),
    ]);
    expect(mergeableMembers(c).map((m) => m.clientId)).toEqual([1, 2]);
    expect(mergeableMembers(card(c.members, { status: 'dismissed' }))).toEqual([]);
    expect(mergeableMembers(card(c.members, { entityKind: 'supplier' }))).toEqual([]);
    expect(canMergeCase(c, true)).toBe(true);
    expect(canMergeCase(c, false)).toBe(false);
    expect(canMergeCase(card([member({})]), true)).toBe(false);
  });

  it('reads order count from facts', () => {
    expect(memberOrderCount(member({ facts: [{ label: 'Заказов', value: 7 }] }))).toBe(7);
    expect(memberOrderCount(member({ facts: [{ label: 'Заказов', value: '3' }] }))).toBe(3);
    expect(memberOrderCount(member({ facts: [{ label: 'Заказов', value: null }] }))).toBeNull();
    expect(memberOrderCount(member({ facts: [{ label: 'Телефон', value: 5 }] }))).toBeNull();
  });

  it('default survivor: more orders, else earliest created, else lowest id', () => {
    const m = (clientId: number, createdAt: string | null, orderCount: number | null) =>
      ({ clientId, name: 'n', createdAt, orderCount });
    expect(defaultSurvivorId([m(1, '2026-01-01', 2), m(2, '2026-02-01', 9)])).toBe(2);
    expect(defaultSurvivorId([m(1, '2026-03-01', null), m(2, '2026-02-01', null)])).toBe(2);
    expect(defaultSurvivorId([m(5, null, null), m(4, null, null)])).toBe(4);
    expect(defaultSurvivorId([])).toBeNull();
  });

  it('merged id follows the survivor', () => {
    const ms = [1, 2, 3].map((clientId) => ({ clientId, name: 'n', createdAt: null, orderCount: null }));
    expect(resolveMergedId(ms, 1, 3)).toBe(3);
    expect(resolveMergedId(ms, 3, 3)).toBe(1);
    expect(resolveMergedId(ms.slice(0, 1), 1, null)).toBeNull();
  });

  it('confirm is blocked by obstacles', () => {
    expect(canConfirmMerge(null, false)).toBe(false);
    expect(canConfirmMerge({ obstacles: [] }, false)).toBe(true);
    expect(canConfirmMerge({ obstacles: [] }, true)).toBe(false);
    expect(canConfirmMerge({ obstacles: [{ code: 'x', message: 'm' }] }, false)).toBe(false);
  });

  it('labels and texts', () => {
    expect(warningLabel('PERSON_TYPE_DIFFERS')).toContain('Разный тип лица');
    expect(warningLabel('UNKNOWN')).toBe('UNKNOWN');
    expect(confirmText('А', 'Б')).toContain('перейдут к «А»; клиент «Б» станет архивным');
    expect(countLines({ projects: 2, orders: 0, phonesMoved: 1 }).map((l) => l.label)).toEqual(['Групп', 'Телефонов перенесено']);
    expect(countLines(null)).toEqual([]);
  });

  it('maps error codes', () => {
    expect(mergeErrorInfo('CLIENT_MERGE_DISABLED').message).toBe('Объединение клиентов пока выключено');
    expect(mergeErrorInfo('CLIENT_MERGE_PREVIEW_STALE')).toEqual({ message: 'Данные изменились — проверьте ещё раз', action: 'refresh_preview' });
    expect(mergeErrorInfo('CLIENT_MERGE_BUSY').message).toBe('Клиентов сейчас изменяют; повторите через минуту');
    expect(mergeErrorInfo('CLIENT_MERGE_UNDO_EXPIRED').message).toBe('Срок отмены истёк');
    expect(mergeErrorInfo('DUPLICATE_CASE_CHANGED').action).toBe('reload_case');
    expect(mergeErrorInfo('WHATEVER', 'сервер')).toEqual({ message: 'сервер', action: 'none' });
  });

  it('reads obstacles from error details', () => {
    expect(obstaclesFromDetails({ obstacles: [{ code: 'a', message: 'Нельзя' }, { nope: 1 }] })).toEqual([{ code: 'a', message: 'Нельзя' }]);
    expect(obstaclesFromDetails(undefined)).toEqual([]);
  });
});
