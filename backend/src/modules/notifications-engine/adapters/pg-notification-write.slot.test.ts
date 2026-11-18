import { describe, expect, it, vi } from 'vitest';
import { normalizeBalloonSlot, PgNotificationWriteAdapter } from './pg-notification-write';

/** Balloon slots (user request 18.11.2026): a fresh balloon of the slot replaces the older not yet shown ones. */
describe('PgNotificationWriteAdapter balloon slots', () => {
  const input = {
    userId: 7, level: 'error' as const, title: 'E2E', message: 'E2E', entityType: 'onec_alert_dispatch', entityId: '5',
    sourceType: 'onec_alert', sourceId: '5', idempotencyKey: 'onec_alert:5:7', balloonMode: 'mandatory' as const,
  };

  it('writes the slot and marks every older not yet replaced balloon of the user and slot (shown or not) as superseded', async () => {
    const created = new Date('2026-11-18T10:00:00Z');
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ notification_id: '11111111-1111-4111-8111-111111111111', created_at: created }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const result = await new PgNotificationWriteAdapter().insertIfAbsent({ query } as never, { ...input, balloonSlot: ' onec_alert:1:agent ' });
    expect(result).toEqual({ created: true, notificationId: '11111111-1111-4111-8111-111111111111' });
    expect(query.mock.calls[0][1].at(-1)).toBe('onec_alert:1:agent');
    const [sql, params] = query.mock.calls[1];
    expect(sql).toMatch(/SET balloon_shown_at = COALESCE\(balloon_shown_at, now\(\)\), balloon_superseded_at = now\(\)/);
    expect(sql).toMatch(/balloon_slot = \$2 AND balloon_superseded_at IS NULL/);
    expect(sql).toMatch(/notification_id <> \$3::uuid AND created_at <= \$4/);
    expect(params).toEqual([7, 'onec_alert:1:agent', '11111111-1111-4111-8111-111111111111', created]);
  });

  it('no slot, no balloon or a repeated write (idempotent): nothing is superseded', async () => {
    const one = vi.fn().mockResolvedValueOnce({ rows: [{ notification_id: 'a', created_at: new Date() }] });
    await new PgNotificationWriteAdapter().insertIfAbsent({ query: one } as never, input);
    expect(one).toHaveBeenCalledTimes(1);
    const noBalloon = vi.fn().mockResolvedValueOnce({ rows: [{ notification_id: 'b', created_at: new Date() }] });
    await new PgNotificationWriteAdapter().insertIfAbsent({ query: noBalloon } as never, { ...input, balloonMode: null, balloonSlot: 'x' });
    expect(noBalloon).toHaveBeenCalledTimes(1);
    expect(noBalloon.mock.calls[0][1].at(-1)).toBeNull();
    const repeated = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ notification_id: 'c' }] });
    expect(await new PgNotificationWriteAdapter().insertIfAbsent({ query: repeated } as never, { ...input, balloonSlot: 'x' }))
      .toEqual({ created: false, notificationId: 'c' });
    expect(repeated.mock.calls[1][0]).toMatch(/^SELECT notification_id/);
  });

  it('normalizes the slot: trimmed, 1–200 characters', () => {
    expect([normalizeBalloonSlot(' a '), normalizeBalloonSlot(''), normalizeBalloonSlot(null), normalizeBalloonSlot('x'.repeat(201))])
      .toEqual(['a', null, null, null]);
  });
});
