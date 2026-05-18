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
          .slice(Math.max(0, index - 12), index)
          .join('\n');

        if (!precedingDecoratorBlock.includes('@ApiOperation(')) {
          missing.push(`${relativeBackendPath(file)}:${index + 1}:${lines[index].trim()}`);
        }
      }

      return missing;
    });

    expect(missingOperationMetadata).toEqual([]);
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
