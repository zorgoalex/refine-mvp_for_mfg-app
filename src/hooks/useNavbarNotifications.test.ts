import { describe, expect, it } from 'vitest';
import type { PanelNotification } from './useBackendNotifications';
import { mergeNavbarNotifications, toLocalPanelNotification } from './useNavbarNotifications';

describe('navbar notifications helpers', () => {
  it('maps frontend warnings into the bell contract', () => {
    expect(
      toLocalPanelNotification({
        id: 'local-1',
        message: 'Настройка не завершена',
        level: 'warning',
        timestamp: 123,
        read: false,
        userId: '7',
      }),
    ).toEqual({
      id: 'local-1',
      message: 'Настройка не завершена',
      level: 'warning',
      timestamp: 123,
      read: false,
      title: null,
      sourceType: 'frontend-warning',
      sourceId: null,
    });
  });

  it('merges backend and frontend notifications newest first', () => {
    const backend = panel('backend', 100);
    const local = panel('local', 200);

    expect(mergeNavbarNotifications([backend], [local]).map((item) => item.id)).toEqual([
      'local',
      'backend',
    ]);
  });
});

function panel(id: string, timestamp: number): PanelNotification {
  return {
    id,
    message: id,
    level: 'warning',
    timestamp,
    read: false,
    title: null,
    sourceType: null,
    sourceId: null,
  };
}
