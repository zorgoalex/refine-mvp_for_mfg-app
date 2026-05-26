import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ProjectsModule wiring', () => {
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
});
