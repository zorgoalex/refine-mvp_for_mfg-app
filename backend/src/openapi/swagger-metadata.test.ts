import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { relative, resolve, sep } from 'path';
import { describe, expect, it } from 'vitest';

describe('Swagger controller metadata', () => {
  it('tags every backend-owned controller included in the stage-1 API contract', () => {
    const missingTags = backendControllerFiles()
      .filter((file) => !readFileSync(file, 'utf8').includes('@ApiTags('))
      .map(relativeBackendPath);

    expect(missingTags).toEqual([]);
  });

  it('documents every route handler with @ApiOperation metadata', () => {
    const missingOperationMetadata = backendControllerFiles().flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      const missing: string[] = [];

      for (let index = 0; index < lines.length; index += 1) {
        if (!/^\s+@(Get|Post|Put|Patch|Delete)\(/.test(lines[index])) {
          continue;
        }

        const precedingDecoratorBlock = lines
          .slice(Math.max(0, index - 24), index)
          .join('\n');

        if (!precedingDecoratorBlock.includes('@ApiOperation(')) {
          missing.push(`${relativeBackendPath(file)}:${index + 1}:${lines[index].trim()}`);
        }
      }

      return missing;
    });

    expect(missingOperationMetadata).toEqual([]);
  });

  it('documents Deadline Worker request validation failures in Swagger metadata', () => {
    const controllerSource = readFileSync(
      resolve(backendRoot(), 'src/modules/deadlines/http/deadline-worker.controller.ts'),
      'utf8',
    );

    expect(routeDecoratorBlock(controllerSource, "Post('process-due-now')")).toContain(
      '@ApiResponse({ status: 422',
    );
    expect(routeDecoratorBlock(controllerSource, "Post('process-due-scheduled')")).toContain(
      '@ApiResponse({ status: 422',
    );
  });

  it('documents Deadline Worker request body schemas in Swagger metadata', () => {
    const controllerSource = readFileSync(
      resolve(backendRoot(), 'src/modules/deadlines/http/deadline-worker.controller.ts'),
      'utf8',
    );

    for (const routeDecorator of ["Post('process-due-now')", "Post('process-due-scheduled')"]) {
      const decoratorBlock = routeDecoratorBlock(controllerSource, routeDecorator);

      expect(decoratorBlock).toContain('@ApiBody({');
      expect(decoratorBlock).toContain("now: { type: 'string', format: 'date-time' }");
      expect(decoratorBlock).toContain("limit: { type: 'integer', minimum: 1 }");
    }
  });
});

function backendRoot(): string {
  const candidates = [resolve(process.cwd(), 'backend'), process.cwd()];
  const root = candidates.find((candidate) => existsSync(resolve(candidate, 'src/modules')));

  expect(root, 'Expected to find backend root from repo root or backend cwd').toBeDefined();

  return root as string;
}

function backendControllerFiles(): string[] {
  return walk(resolve(backendRoot(), 'src/modules'))
    .filter((file) => file.endsWith('controller.ts'))
    .filter((file) => !relativeBackendPath(file).startsWith('src/modules/health/'))
    .sort();
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = resolve(directory, entry);
    const stat = statSync(fullPath);

    return stat.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function relativeBackendPath(path: string): string {
  return relative(backendRoot(), path).split(sep).join('/');
}

function routeDecoratorBlock(source: string, routeDecorator: string): string {
  const routeIndex = source.indexOf(`@${routeDecorator}`);

  expect(routeIndex, `Expected to find @${routeDecorator}`).toBeGreaterThanOrEqual(0);

  const linesBeforeRoute = source.slice(0, routeIndex).split('\n');

  return linesBeforeRoute.slice(-20).join('\n');
}
