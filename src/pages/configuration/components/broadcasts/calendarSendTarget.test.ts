import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ settings: vi.fn(), groups: vi.fn() }));
vi.mock('../../../../api/broadcastsApi', () => ({ broadcastsApi: { calendarSendSettings: mocks.settings } }));
vi.mock('../../../../api/whatsappApi', () => ({ whatsappApi: { groups: mocks.groups } }));

import { calendarSendTooltip, loadCalendarSendTarget } from './calendarSendTarget';
import { resetWhatsAppGroupsCacheForTests } from '../whatsappGroupsCache';

const id = '120363000000000001@g.us';
const envelope = (groupChatId: string | null) => ({ settings: { groupChatId } });
const groups = { groups: [{ id, name: 'ЧПУ', participantCount: 3, announceOnly: false, communityParent: false, suspended: false }], truncated: false, fetchedAt: '', cached: true };

describe('calendar send target', () => {
  afterEach(() => { mocks.settings.mockReset(); mocks.groups.mockReset(); resetWhatsAppGroupsCacheForTests(); });

  it('names the chat, or says that no group is chosen', () => {
    expect(calendarSendTooltip({ kind: 'group', name: 'ЧПУ' })).toBe('Отправить в чат «ЧПУ»');
    expect(calendarSendTooltip({ kind: 'group', name: null })).toBe('Отправить в чат');
    expect(calendarSendTooltip({ kind: 'unknown' })).toBe('Отправить в чат');
    expect(calendarSendTooltip({ kind: 'none' })).toContain('группа не выбрана');
  });

  it('reads the group from the settings and its name from the group list', async () => {
    mocks.settings.mockResolvedValue(envelope(id));
    mocks.groups.mockResolvedValue(groups);
    await expect(loadCalendarSendTarget()).resolves.toEqual({ kind: 'group', name: 'ЧПУ' });
  });

  it('does not ask for groups when no group is set and keeps the id-only state when the list fails', async () => {
    mocks.settings.mockResolvedValueOnce(envelope(null));
    await expect(loadCalendarSendTarget()).resolves.toEqual({ kind: 'none' });
    expect(mocks.groups).not.toHaveBeenCalled();
    mocks.settings.mockResolvedValueOnce(envelope(id));
    mocks.groups.mockRejectedValueOnce(new Error('offline'));
    await expect(loadCalendarSendTarget()).resolves.toEqual({ kind: 'group', name: null });
  });
});
