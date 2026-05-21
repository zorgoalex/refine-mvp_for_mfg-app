import { describe, expect, it } from 'vitest';
import { shouldEnableOrderDeadlineSync } from './orders.module';

describe('OrdersModule deadline sync gating', () => {
  it('does not enable order deadline sync for read-only or cancel-only deadline runtime', () => {
    expect(
      shouldEnableOrderDeadlineSync({
        databaseConfigured: true,
        deadlinesEnabled: true,
        deadlinesReadOnly: true,
        orderSyncEnabled: false,
      }),
    ).toBe(false);

    expect(
      shouldEnableOrderDeadlineSync({
        databaseConfigured: true,
        deadlinesEnabled: true,
        deadlinesReadOnly: false,
        orderSyncEnabled: false,
      }),
    ).toBe(false);
  });

  it('enables order deadline sync only behind its explicit gate', () => {
    expect(
      shouldEnableOrderDeadlineSync({
        databaseConfigured: true,
        deadlinesEnabled: true,
        deadlinesReadOnly: false,
        orderSyncEnabled: true,
      }),
    ).toBe(true);

    expect(
      shouldEnableOrderDeadlineSync({
        databaseConfigured: false,
        deadlinesEnabled: true,
        deadlinesReadOnly: false,
        orderSyncEnabled: true,
      }),
    ).toBe(false);
  });
});
