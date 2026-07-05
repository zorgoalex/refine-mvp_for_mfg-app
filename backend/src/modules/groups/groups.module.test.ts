import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GroupsModule wiring', () => {
  function readGroupsModule(): string {
    const candidates = [
      resolve(process.cwd(), 'backend/src/modules/groups/groups.module.ts'),
      resolve(process.cwd(), 'src/modules/groups/groups.module.ts'),
    ];
    const modulePath = candidates.find((candidate) => existsSync(candidate));

    expect(modulePath).toBeDefined();

    return readFileSync(modulePath as string, 'utf8');
  }

  it('is imported by the backend AppModule', () => {
    const candidates = [
      resolve(process.cwd(), 'backend/src/app.module.ts'),
      resolve(process.cwd(), 'src/app.module.ts'),
    ];
    const appModulePath = candidates.find((candidate) => existsSync(candidate));

    expect(appModulePath).toBeDefined();

    const appModule = readFileSync(appModulePath as string, 'utf8');

    expect(appModule).toContain("import { GroupsModule } from './modules/groups/groups.module'");
    expect(appModule).toMatch(/imports:\s*\[[\s\S]*GroupsModule[\s\S]*\]/);
  });

  it('registers group notification providers with fail-closed database wiring', () => {
    const groupsModule = readGroupsModule();

    expect(groupsModule).toContain('GroupNotificationService');
    expect(groupsModule).toContain('PgGroupNotificationRecipientRepository');
    expect(groupsModule).toContain('UnavailableGroupNotificationRecipientRepository');
    expect(groupsModule).toContain('PgGroupNotificationRepository');
    expect(groupsModule).toContain('UnavailableGroupNotificationRepository');
    expect(groupsModule).toContain('database.isConfigured');
  });

  it('registers group batch-link dry-run with fail-closed database wiring', () => {
    const groupsModule = readGroupsModule();

    expect(groupsModule).toContain('GroupBatchLinkController');
    expect(groupsModule).toContain('GroupBatchLinkService');
    expect(groupsModule).toContain('PgGroupBatchLinkRepository');
    expect(groupsModule).toContain('UnavailableGroupBatchLinkRepository');
    expect(groupsModule).toContain('database.isConfigured');
  });
});
