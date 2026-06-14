import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ProjectsModule wiring', () => {
  function readProjectsModule(): string {
    const candidates = [
      resolve(process.cwd(), 'backend/src/modules/projects/projects.module.ts'),
      resolve(process.cwd(), 'src/modules/projects/projects.module.ts'),
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

    expect(appModule).toContain("import { ProjectsModule } from './modules/projects/projects.module'");
    expect(appModule).toMatch(/imports:\s*\[[\s\S]*ProjectsModule[\s\S]*\]/);
  });

  it('registers project notification providers with fail-closed database wiring', () => {
    const projectsModule = readProjectsModule();

    expect(projectsModule).toContain('ProjectNotificationService');
    expect(projectsModule).toContain('PgProjectNotificationRecipientRepository');
    expect(projectsModule).toContain('UnavailableProjectNotificationRecipientRepository');
    expect(projectsModule).toContain('PgProjectNotificationRepository');
    expect(projectsModule).toContain('UnavailableProjectNotificationRepository');
    expect(projectsModule).toContain('database.isConfigured');
  });

  it('registers project batch-link dry-run with fail-closed database wiring', () => {
    const projectsModule = readProjectsModule();

    expect(projectsModule).toContain('ProjectBatchLinkController');
    expect(projectsModule).toContain('ProjectBatchLinkService');
    expect(projectsModule).toContain('PgProjectBatchLinkRepository');
    expect(projectsModule).toContain('UnavailableProjectBatchLinkRepository');
    expect(projectsModule).toContain('database.isConfigured');
  });
});
