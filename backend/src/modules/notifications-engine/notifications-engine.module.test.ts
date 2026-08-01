import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('NotificationsEngineModule wiring', () => {
  it('is imported by the backend AppModule', () => {
    const candidates = [
      resolve(process.cwd(), 'backend/src/app.module.ts'),
      resolve(process.cwd(), 'src/app.module.ts'),
    ];
    const appModulePath = candidates.find((candidate) => existsSync(candidate));

    expect(appModulePath).toBeDefined();

    const appModule = readFileSync(appModulePath as string, 'utf8');

    expect(appModule).toContain(
      "import { NotificationsEngineModule } from './modules/notifications-engine/notifications-engine.module'",
    );
    expect(appModule).toMatch(/imports:\s*\[[\s\S]*NotificationsEngineModule[\s\S]*\]/);
  });

  it('registers the engine controllers, services, and adapters', () => {
    const candidates = [
      resolve(process.cwd(), 'backend/src/modules/notifications-engine/notifications-engine.module.ts'),
      resolve(process.cwd(), 'src/modules/notifications-engine/notifications-engine.module.ts'),
    ];
    const modulePath = candidates.find((candidate) => existsSync(candidate));

    expect(modulePath).toBeDefined();

    const notificationsEngineModule = readFileSync(modulePath as string, 'utf8');

    expect(notificationsEngineModule).toContain('NotificationRulesController');
    expect(notificationsEngineModule).toContain('OutboxRelayController');
    expect(notificationsEngineModule).toContain('NotificationRulesService');
    expect(notificationsEngineModule).toContain('NotificationRuleEngineService');
    expect(notificationsEngineModule).toContain('OutboxRelayService');
    expect(notificationsEngineModule).toContain('OutboxRelaySchedulerService');
    expect(notificationsEngineModule).toContain('NotificationsRuntimeConfigService');
    expect(notificationsEngineModule).toContain('PgNotificationRuleRepository');
    expect(notificationsEngineModule).toContain('PgRecipientSourceAdapter');
    expect(notificationsEngineModule).toContain('PgVisibilityAdapter');
    expect(notificationsEngineModule).toContain('PgNotificationWriteAdapter');
    expect(notificationsEngineModule).toContain('PgNotificationContextBuilder');
    expect(notificationsEngineModule).toContain('PgOutboxRepository');
    expect(notificationsEngineModule).toContain('isEngineOwnedEvent');
    expect(notificationsEngineModule).toContain("eventType === 'orders.production_initialized'");
    expect(notificationsEngineModule).toContain('syncOrderDeadlinesInTransaction');
    expect(notificationsEngineModule).toContain('Production deadline initialization is unavailable');
  });
});
