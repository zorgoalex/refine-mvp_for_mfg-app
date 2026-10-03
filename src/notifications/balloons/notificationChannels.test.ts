import { describe, expect, it } from 'vitest';
import { channelLabel, normalizeChannels } from './notificationChannels';

describe('notification channels (plan 2026-10-03)', () => {
  it('balloon needs in_app: choosing it adds in_app; removing in_app removes the balloon', () => {
    expect(normalizeChannels(['balloon'], [])).toEqual(['in_app', 'balloon']);
    expect(normalizeChannels(['in_app', 'balloon'], ['in_app'])).toEqual(['in_app', 'balloon']);
    expect(normalizeChannels(['balloon', 'telegram'], ['in_app', 'balloon', 'telegram'])).toEqual(['telegram']);
    expect(normalizeChannels(['telegram'], ['in_app'])).toEqual(['telegram']);
  });

  it('table labels show the balloon mode', () => {
    expect(channelLabel('balloon', 'persistent')).toBe('Балун · до крестика');
    expect(channelLabel('balloon', undefined)).toBe('Балун · 15 с');
    expect(channelLabel('in_app', 'auto')).toBe('В приложении');
  });
});
