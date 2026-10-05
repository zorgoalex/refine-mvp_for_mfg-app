import { describe, expect, it } from 'vitest';
import {
  USER_VISIBILITY_KEY,
  buildInitialResourceVisibility,
  canViewResourceForUser,
  setUserVisibilityOverride,
  type RoleVisibilityMatrix,
} from './resourceVisibility';
import { createVisibilityWriter } from './visibilityWriter';

function deferredSave() {
  const saved: RoleVisibilityMatrix[] = [];
  const releases: Array<(fail?: boolean) => void> = [];
  const save = (next: RoleVisibilityMatrix) => new Promise<void>((resolve, reject) => {
    releases.push((fail) => {
      if (fail) reject(new Error('save failed'));
      else {
        saved.push(next);
        resolve();
      }
    });
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { saved, releases, save, flush };
}

const base: RoleVisibilityMatrix = { orders_view: { manager: true, operator: true } };
const roleToggle = (resource: string, roleKey: string, checked: boolean) => (matrix: RoleVisibilityMatrix) => {
  const built = buildInitialResourceVisibility([{ name: 'orders_view' }, { name: 'calendar' }], [{ role_id: 10 }, { role_id: 11 }], matrix);
  return { ...built, [resource]: { ...(built[resource] ?? {}), [roleKey]: checked } };
};

describe('visibility writer', () => {
  it('a role change queued while a personal override is saving keeps the override (review R1 scenario)', async () => {
    const io = deferredSave();
    const writer = createVisibilityWriter(base, io.save);
    const personal = writer.apply((m) => setUserVisibilityOverride(m, 'orders_view', 42, 'hide'));
    const role = writer.apply(roleToggle('calendar', 'manager', false));
    expect(writer.pending).toBe(2);
    await io.flush();
    expect(io.releases).toHaveLength(1); // the second write waits for the first
    io.releases[0]();
    await personal;
    expect(writer.pending).toBe(1); // the role write is still queued
    await io.flush();
    io.releases[1]();
    const final = await role;
    expect(writer.pending).toBe(0); // readable right after await: the UI unlocks
    expect(io.saved).toHaveLength(2);
    expect((final as Record<string, unknown>)[USER_VISIBILITY_KEY]).toEqual({ orders_view: { 42: false } });
    expect(final.calendar.manager).toBe(false);
    expect(canViewResourceForUser('orders_view', { id: 42, role: 'manager' }, final)).toBe(false);
    expect(writer.current).toBe(final);
  });

  it('a failed save leaves the last saved state and does not block later writes', async () => {
    const io = deferredSave();
    const writer = createVisibilityWriter(base, io.save);
    const failing = writer.apply((m) => setUserVisibilityOverride(m, 'orders_view', 42, 'hide'));
    await io.flush();
    io.releases[0](true);
    await expect(failing).rejects.toThrow('save failed');
    expect(writer.pending).toBe(0); // a failed save unlocks too
    expect(writer.current).toBe(base);
    const next = writer.apply((m) => setUserVisibilityOverride(m, 'calendar', 7, 'show'));
    await io.flush();
    io.releases[1]();
    expect(await next).toEqual(setUserVisibilityOverride(base, 'calendar', 7, 'show'));
    expect(writer.pending).toBe(0);
  });

  it('adopts a reloaded setting only when nothing is pending', async () => {
    const io = deferredSave();
    const writer = createVisibilityWriter(base, io.save);
    const reloaded: RoleVisibilityMatrix = { orders_view: { manager: false } };
    const write = writer.apply((m) => m);
    expect(writer.sync(reloaded)).toBe(false);
    await io.flush();
    io.releases[0]();
    await write;
    expect(writer.sync(reloaded)).toBe(true);
    expect(writer.current).toBe(reloaded);
  });
});
