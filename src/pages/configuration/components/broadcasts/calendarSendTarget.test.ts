import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ settings: vi.fn(), availability: vi.fn(), groups: vi.fn() }));
vi.mock('../../../../api/broadcastsApi', () => ({ broadcastsApi: { calendarSendSettings: mocks.settings, calendarSendAvailability: mocks.availability } }));
vi.mock('../../../../api/whatsappApi', () => ({ whatsappApi: { groups: mocks.groups } }));

import { calendarSendTooltip, loadCalendarSendTarget } from './calendarSendTarget';
import { resetWhatsAppGroupsCacheForTests } from '../whatsappGroupsCache';

const id = '120363000000000001@g.us';
const envelope = (groupChatId: string | null) => ({ settings: { groupChatId } });
const groups = { groups: [{ id, name: 'ЧПУ', participantCount: 3, announceOnly: false, communityParent: false, suspended: false }], truncated: false, fetchedAt: '', cached: true };

describe('calendar send target', () => {
  afterEach(() => { mocks.settings.mockReset(); mocks.availability.mockReset(); mocks.groups.mockReset(); resetWhatsAppGroupsCacheForTests(); });

  it('names the chat, or says that no group is chosen', () => {
    expect(calendarSendTooltip({ kind: 'group', name: 'ЧПУ' })).toBe('Отправить в чат «ЧПУ»');
    expect(calendarSendTooltip({ kind: 'group', name: null })).toBe('Отправить в чат');
    expect(calendarSendTooltip({ kind: 'unknown' })).toBe('Отправить в чат');
    expect(calendarSendTooltip({ kind: 'none' })).toContain('группа не выбрана');
  });

  it('reads the group from the settings and its name from the group list', async () => {
    mocks.settings.mockResolvedValue(envelope(id));
    mocks.groups.mockResolvedValue(groups);
    await expect(loadCalendarSendTarget(true)).resolves.toEqual({ kind: 'group', name: 'ЧПУ' });
  });

  it('does not ask for groups when no group is set and keeps the id-only state when the list fails', async () => {
    mocks.settings.mockResolvedValueOnce(envelope(null));
    await expect(loadCalendarSendTarget(true)).resolves.toEqual({ kind: 'none' });
    expect(mocks.groups).not.toHaveBeenCalled();
    mocks.settings.mockResolvedValueOnce(envelope(id));
    mocks.groups.mockRejectedValueOnce(new Error('offline'));
    await expect(loadCalendarSendTarget(true)).resolves.toEqual({ kind: 'group', name: null });
  });

  it('without the settings permission reads only whether a group is chosen — never the settings or the group list', async () => {
    mocks.availability.mockResolvedValueOnce({ configured: true, minIntervalMinutes: 15, nextAllowedAt: null, activeRun: false });
    await expect(loadCalendarSendTarget(false)).resolves.toEqual({ kind: 'group', name: null });
    mocks.availability.mockResolvedValueOnce({ configured: false, minIntervalMinutes: 15, nextAllowedAt: null, activeRun: false });
    await expect(loadCalendarSendTarget(false)).resolves.toEqual({ kind: 'none' });
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.groups).not.toHaveBeenCalled();
  });
});
