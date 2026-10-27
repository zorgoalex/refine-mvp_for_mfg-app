import { describe, expect, it } from 'vitest';
import type { PanelNotification } from './useBackendNotifications';
import { mergeNavbarNotifications, splitShownIds, toLocalPanelNotification } from './useNavbarNotifications';

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
      deletable: true,
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
    deletable: true,
  };
}

describe('«Все прочитаны»', () => {
  it('sends to the server only backend rows that are actually displayed', () => {
    const panel = (id: string, timestamp: number): PanelNotification => ({
      id, message: id, level: 'info', timestamp, read: false, title: null, sourceType: null, sourceId: null, deletable: true,
    });
    const backend = [panel('backend-old', 1)];
    const locals = Array.from({ length: 100 }, (_, i) => panel(`local-${i}`, 1000 + i));
    const displayed = mergeNavbarNotifications(backend, locals).map((n) => n.id);

    const { local, remote } = splitShownIds(displayed, new Set(locals.map((n) => n.id)));
    expect(local).toHaveLength(100);
    expect(remote).toEqual([]); // the displaced backend row is not sent, so it stays unread
  });
});
