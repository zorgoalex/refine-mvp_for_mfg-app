import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./backfill-cnc-telegram-label-maps.ts', import.meta.url), 'utf8');

describe('CNC Telegram label-map backfill', () => {
  it('sets the database session actor before projecting rows', () => {
    const begin = source.indexOf("client.query('BEGIN')");
    const sessionActor = source.indexOf("client.query('SELECT set_session_user($1)', [actorUserId])", begin);
    const projection = source.indexOf('projectTelegramLabelMap(tx', begin);

    expect(begin).toBeGreaterThanOrEqual(0);
    expect(sessionActor).toBeGreaterThan(begin);
    expect(projection).toBeGreaterThan(sessionActor);
  });
});
