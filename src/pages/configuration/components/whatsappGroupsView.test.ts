import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../api/apiError';
import type { WhatsAppGroupDto } from '../../../api/types/whatsappApi.types';
import {
  filterGroups,
  findGroupById,
  formatFetchedAt,
  groupDisplayName,
  groupWarnings,
  groupsErrorText,
} from './whatsappGroupsView';

const base: WhatsAppGroupDto = {
  id: '120363338054016575@g.us', name: 'ЧПУ', participantCount: 12,
  announceOnly: false, communityParent: false, suspended: false,
};
const groups: WhatsAppGroupDto[] = [
  base,
  { ...base, id: '120363000000000001@g.us', name: '', participantCount: null },
  { ...base, id: '999999999-111111@g.us', name: 'Склад' },
];
const err = (code: string, status: number) => new ApiError({ code, message: code, status } as never);

describe('whatsappGroupsView', () => {
  it('filters by name or id, case-insensitive and trimmed', () => {
    expect(filterGroups(groups, '  чпу ').map((g) => g.id)).toEqual([base.id]);
    expect(filterGroups(groups, '999999999').map((g) => g.name)).toEqual(['Склад']);
    expect(filterGroups(groups, '   ')).toHaveLength(3);
    expect(filterGroups(groups, 'нет такой')).toEqual([]);
  });
  it('falls back to a placeholder name', () => {
    expect(groupDisplayName(groups[1])).toBe('Без названия');
    expect(groupDisplayName({ name: '  ' })).toBe('Без названия');
    expect(groupDisplayName(base)).toBe('ЧПУ');
  });
  it('produces warnings per flag', () => {
    expect(groupWarnings(base)).toEqual([]);
    const all = groupWarnings({ ...base, announceOnly: true, communityParent: true, suspended: true });
    expect(all.map((w) => w.key)).toEqual(['announceOnly', 'communityParent', 'suspended']);
    expect(all[0].text).toContain('Пишут только администраторы');
    expect(all[2].label).toBe('Заблокирована');
  });
  it('finds a group by id', () => {
    expect(findGroupById(groups, ` ${base.id} `)).toBe(base);
    expect(findGroupById(groups, 'x@g.us')).toBeUndefined();
    expect(findGroupById(groups, null)).toBeUndefined();
  });
  it('maps error codes to Russian text', () => {
    expect(groupsErrorText(err('WHATSAPP_SESSION_NOT_READY', 409))).toContain('WhatsApp не подключён');
    expect(groupsErrorText(err('WHATSAPP_NOT_CONFIGURED', 503))).toContain('выключена');
    expect(groupsErrorText(err('WAHA_UNAVAILABLE', 503))).toContain('WAHA недоступен');
    expect(groupsErrorText(err('WAHA_PROVIDER_ERROR', 502))).toContain('WAHA');
    expect(groupsErrorText(err('X', 403))).toContain('whatsapp.manage');
    expect(groupsErrorText(new TypeError('x'))).toContain('backend');
    expect(groupsErrorText(new Error('x'))).toBe('Не удалось загрузить список групп.');
  });
  it('formats fetchedAt as HH:MM and tolerates garbage', () => {
    expect(formatFetchedAt('nope')).toBe('');
    expect(formatFetchedAt('2026-09-29T10:00:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('whatsapp groups wiring guards', () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  it('connection tab shows the groups card only under the manage gate', () => {
    expect(read('./WhatsAppConfigTabs.tsx')).toContain('{canManage ? <WhatsAppGroupsCard /> : null}');
  });
  it('picker never auto-polls and loads on focus/open', () => {
    const src = read('./WhatsAppGroupSelect.tsx');
    expect(src).not.toMatch(/setInterval/);
    expect(src).toContain('onFocus');
    expect(src).toContain('onDropdownVisibleChange');
  });
  it('digest and signal sources use the picker with aligned validation', () => {
    expect(read('./DailyOrderDigestConfig.tsx')).toContain('<WhatsAppGroupSelect');
    expect(read('./DailyOrderDigestConfig.tsx')).toContain('{5,24}(?:-\\d{5,24})?@g\\.us');
    expect(read('./MessageProcessingConfig.tsx')).toContain("can('whatsapp.manage')");
  });
});
