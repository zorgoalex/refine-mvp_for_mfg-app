import { describe, expect, it } from 'vitest';
import { buildDuplicatesQuery } from '../../api/integrationDuplicatesApi';
import type { DuplicateMember } from '../../api/integrationDuplicatesApiTypes';
import { RESOURCE_PERMISSION_MAP, canViewNavigationResource } from '../../utils/navigationPermissions';
import {
  actionLabel, availableActions, caseAuthor, commandAllowed, keyMaskText, memberErpLink, memberName,
  resolutionLabel, viaLabel,
} from './duplicatesModel';
import { integrationTabs } from './integrationsModel';

const member = (over: Partial<DuplicateMember>): DuplicateMember => ({
  system: 'erp', entityKind: 'client', recordKey: '1', erpEntityId: 1, name: 'А', joinedAt: '2026-10-01T00:00:00Z',
  leftAt: null, recordCreatedAt: null, author: null, authorExternal: null, via: 'erp_manual', ...over,
});

describe('duplicates model', () => {
  it('labels', () => {
    expect(viaLabel('onec_publication')).toBe('Из 1С');
    expect(viaLabel('zzz')).toBe('—');
    expect(actionLabel('dismissed')).toBe('Отмечен «Не дубль»');
    expect(resolutionLabel('no_match')).toBe('совпадение пропало');
    expect(resolutionLabel(null)).toBe('—');
  });

  it('key mask notes', () => {
    expect(keyMaskText({ keyMask: '77*****01', sourcesState: 'current' })).toBe('77*****01');
    expect(keyMaskText({ keyMask: null, sourcesState: 'refreshing' })).toBe('данные 1С обновляются');
    expect(keyMaskText({ keyMask: null, sourcesState: 'unavailable' })).toBe('данные 1С отозваны');
  });

  it('member name fallback', () => {
    expect(memberName(member({ name: null }))).toBe('Клиент #1');
    expect(memberName(member({ name: null, erpEntityId: null, system: 'onec' }))).toBe('нет доступа');
  });

  it('author is taken from the latest joined present member', () => {
    const members = [
      member({ recordKey: 'a', joinedAt: '2026-10-01T00:00:00Z', author: { userId: 1, username: 'old' } }),
      member({ recordKey: 'b', joinedAt: '2026-10-05T00:00:00Z', authorExternal: 'Менеджер 1С' }),
      member({ recordKey: 'c', joinedAt: '2026-10-09T00:00:00Z', leftAt: '2026-10-10T00:00:00Z', author: { userId: 2, username: 'gone' } }),
    ];
    expect(caseAuthor(members)).toBe('Менеджер 1С');
    expect(caseAuthor([member({})])).toBe('—');
  });

  it('erp links', () => {
    expect(memberErpLink(member({}))).toBe('/clients/edit/1');
    expect(memberErpLink(member({ entityKind: 'supplier', erpEntityId: 5 }))).toBe('/suppliers/edit/5');
    expect(memberErpLink(member({ system: 'onec' }))).toBeNull();
    expect(memberErpLink(member({ entityKind: 'film' }))).toBeNull();
  });

  it('actions by status and permission', () => {
    expect(availableActions({ status: 'open', external: 'onec' }, true)).toEqual({ dismiss: true, external: true, reopen: false });
    expect(availableActions({ status: 'open', external: null }, true)).toEqual({ dismiss: true, external: false, reopen: false });
    expect(availableActions({ status: 'external', external: 'onec' }, true).reopen).toBe(true);
    expect(availableActions({ status: 'merged', external: null }, true)).toEqual({ dismiss: false, external: false, reopen: false });
    expect(availableActions({ status: 'open', external: 'onec' }, false).dismiss).toBe(false);
  });

  it('a command goes only for the loaded card of the case shown', () => {
    expect(commandAllowed({ caseId: 1 }, 1, false)).toBe(true);
    expect(commandAllowed({ caseId: 1 }, 2, false)).toBe(false);
    expect(commandAllowed({ caseId: 1 }, 1, true)).toBe(false);
    expect(commandAllowed(null, 1, false)).toBe(false);
    expect(resolutionLabel('different_records')).toBe('разные записи');
  });

  it('query building skips empty filters', () => {
    expect(buildDuplicatesQuery({})).toBe('');
    expect(buildDuplicatesQuery({ status: 'open', search: ' ооо ', page: 2, pageSize: 50, ruleCode: '' }))
      .toBe('?status=open&search=%D0%BE%D0%BE%D0%BE&page=2&pageSize=50');
  });

  it('tabs depend on access', () => {
    expect(integrationTabs({ canDuplicates: true, canOnec: false, canBitrix: true }).map((t) => t.key)).toEqual(['duplicates', 'bitrix']);
    expect(integrationTabs({ canDuplicates: false, canOnec: true, canBitrix: true }).map((t) => t.key)).toEqual(['onec', 'bitrix']);
  });

  it('navigation resource needs the view permission', () => {
    expect(RESOURCE_PERMISSION_MAP.integrations).toEqual(['integrations.duplicates.view']);
    expect(canViewNavigationResource('integrations', { permissions: ['integrations.duplicates.view'] }, true)).toBe(true);
    expect(canViewNavigationResource('integrations', { permissions: ['integrations.duplicates.resolve'] }, true)).toBe(false);
  });
});
