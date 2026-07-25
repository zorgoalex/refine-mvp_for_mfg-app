import { describe, expect, it } from 'vitest';
import {
  BackfillInterruptedError,
  interruptibleSleep,
  parseBackfillCliOptions,
} from './crm-sync-backfill-options';

describe('CRM backfill CLI options', () => {
  it('requires an explicit clients/all scope', () => {
    expect(() => parseBackfillCliOptions([])).toThrow(/--scope clients\|all is required/);
    expect(parseBackfillCliOptions(['--scope', 'clients'])).toEqual({
      dryRun: false,
      restart: false,
      scope: 'clients',
      progressEvery: 25,
    });
    expect(parseBackfillCliOptions([
      '--scope=all',
      '--restart',
      '--progress-every=100',
    ])).toEqual({
      dryRun: false,
      restart: true,
      scope: 'all',
      progressEvery: 100,
    });
  });

  it('rejects invalid, duplicate, unknown and contradictory options', () => {
    expect(() => parseBackfillCliOptions(['--scope', 'orders'])).toThrow(
      /clients or all/,
    );
    expect(() => parseBackfillCliOptions([
      '--scope=clients',
      '--scope=all',
    ])).toThrow(/duplicate option/);
    expect(() => parseBackfillCliOptions(['--scope'])).toThrow(/requires a value/);
    expect(() => parseBackfillCliOptions([
      '--scope=clients',
      '--dry-run',
      '--restart',
    ])).toThrow(/cannot be used together/);
    expect(() => parseBackfillCliOptions([
      '--scope=clients',
      '--wat',
    ])).toThrow(/unknown option/);
  });

  it('interrupts a limiter wait without waiting for its timer', async () => {
    const controller = new AbortController();
    const waiting = interruptibleSleep(60_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(BackfillInterruptedError);
  });
});
