import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { REQUIRED_PERMISSIONS_METADATA_KEY } from '../../../permissions/require-permissions.decorator';
import { OutboxRelayController } from './outbox-relay.controller';
import type { NotificationsFeatureFlags } from './notifications-runtime-config.service';
import type { OutboxRelaySummary } from '../application/outbox-relay.service';

describe('OutboxRelayController', () => {
  describe('process-now', () => {
    it('rejects with 503 NOTIFICATION_ENGINE_DISABLED when the engine is disabled', async () => {
      const controller = createController({ flags: flags({ engineEnabled: false }) });

      await expect(controller.processNow({ user: currentUser(), requestId: 'req-1' } as never)).rejects.toMatchObject({
        statusCode: 503,
        code: 'NOTIFICATION_ENGINE_DISABLED',
      } satisfies Partial<ApiError>);
    });

    it('requires a current user', async () => {
      const controller = createController({ flags: flags({ engineEnabled: true }) });

      await expect(controller.processNow({ requestId: 'req-1' } as never)).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      } satisfies Partial<ApiError>);
    });

    it('calls relay.processBatchOnce and returns its summary when enabled with a current user', async () => {
      const summary: OutboxRelaySummary = { claimed: 3, processed: 2, failed: 1 };
      const relay = createRelay({ processBatchOnce: vi.fn().mockResolvedValue(summary) });
      const controller = createController({ flags: flags({ engineEnabled: true }), relay });

      await expect(
        controller.processNow({ user: currentUser(), requestId: 'req-1' } as never),
      ).resolves.toEqual(summary);
      expect(relay.processBatchOnce).toHaveBeenCalledTimes(1);
    });
  });

  describe('process-scheduled', () => {
    it('rejects with 503 NOTIFICATION_ENGINE_DISABLED when the engine is disabled', async () => {
      const controller = createController({
        flags: flags({ engineEnabled: false, relayOwner: 'external' }),
      });

      await expect(
        controller.processScheduled({ user: currentUser(), requestId: 'req-1' } as never),
      ).rejects.toMatchObject({
        statusCode: 503,
        code: 'NOTIFICATION_ENGINE_DISABLED',
      } satisfies Partial<ApiError>);
    });

    it('requires a current user', async () => {
      const controller = createController({
        flags: flags({ engineEnabled: true, relayOwner: 'external' }),
      });

      await expect(controller.processScheduled({ requestId: 'req-1' } as never)).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      } satisfies Partial<ApiError>);
    });

    it('rejects with 503 OUTBOX_RELAY_SCHEDULER_OWNER_MISMATCH when owner is not external', async () => {
      const controller = createController({
        flags: flags({ engineEnabled: true, relayOwner: 'in_process' }),
      });

      await expect(
        controller.processScheduled({ user: currentUser(), requestId: 'req-1' } as never),
      ).rejects.toMatchObject({
        statusCode: 503,
        code: 'OUTBOX_RELAY_SCHEDULER_OWNER_MISMATCH',
      } satisfies Partial<ApiError>);
    });

    it('calls relay.processBatchOnce and returns its summary when owner is external', async () => {
      const summary: OutboxRelaySummary = { claimed: 5, processed: 5, failed: 0 };
      const relay = createRelay({ processBatchOnce: vi.fn().mockResolvedValue(summary) });
      const controller = createController({
        flags: flags({ engineEnabled: true, relayOwner: 'external' }),
        relay,
      });

      await expect(
        controller.processScheduled({ user: currentUser(), requestId: 'req-1' } as never),
      ).resolves.toEqual(summary);
      expect(relay.processBatchOnce).toHaveBeenCalledTimes(1);
    });
  });

  describe('@RequirePermissions metadata', () => {
    it('requires notifications.manage_rules on both endpoints', () => {
      for (const handler of [
        OutboxRelayController.prototype.processNow,
        OutboxRelayController.prototype.processScheduled,
      ]) {
        expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_METADATA_KEY, handler)).toEqual([
          'notifications.manage_rules',
        ]);
      }
    });
  });
});

function createController(overrides: {
  flags?: NotificationsFeatureFlags;
  relay?: { processBatchOnce(): Promise<OutboxRelaySummary> };
} = {}) {
  const relay = overrides.relay ?? createRelay();

  return new OutboxRelayController(relay as never, {
    getFeatureFlags: () => overrides.flags ?? flags(),
    isEngineEnabled: () => (overrides.flags ?? flags()).engineEnabled,
    isRulesReadOnly: () => (overrides.flags ?? flags()).rulesReadOnly,
  } as never);
}

function createRelay(overrides: { processBatchOnce?: () => Promise<OutboxRelaySummary> } = {}) {
  return {
    processBatchOnce:
      overrides.processBatchOnce ??
      vi.fn().mockResolvedValue({ claimed: 0, processed: 0, failed: 0 } satisfies OutboxRelaySummary),
  };
}

function flags(overrides: Partial<NotificationsFeatureFlags> = {}): NotificationsFeatureFlags {
  return {
    engineEnabled: true,
    rulesReadOnly: false,
    relayOwner: 'none',
    relayPollIntervalMs: 60000,
    relayBatchSize: 100,
    relayWorkerId: 'backend-local',
    relayMaxAttempts: 10,
    ...overrides,
  };
}

function currentUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'admin-id',
    username: 'admin',
    role: 'superadmin',
    roleId: 1,
    permissions: ['notifications.view_rules', 'notifications.manage_rules'],
    ...overrides,
  };
}
