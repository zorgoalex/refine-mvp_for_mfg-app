import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const CONTROLLER_FILES = [
  'src/modules/auth/http/auth.controller.ts',
  'src/modules/users/http/users.controller.ts',
  'src/modules/orders/http/orders.controller.ts',
  'src/modules/orders/http/order-export.controller.ts',
  'src/modules/orders/http/order-snapshot.controller.ts',
  'src/modules/payments/http/payments.controller.ts',
  'src/modules/client-phones/http/client-phones.controller.ts',
  'src/modules/production-actions/http/production-actions.controller.ts',
  'src/modules/vlm/http/vlm.controller.ts',
  'src/modules/deadlines/http/deadlines.controller.ts',
  'src/modules/deadlines/http/deadline-policies.controller.ts',
  'src/modules/deadlines/http/deadline-settings.controller.ts',
] as const;

describe('Swagger controller metadata', () => {
  it('tags every backend-owned controller included in the stage-1 API contract', () => {
    const missingTags = CONTROLLER_FILES.filter((file) => !readBackendFile(file).includes('@ApiTags('));

    expect(missingTags).toEqual([]);
  });

  it('documents every route handler with @ApiOperation metadata', () => {
    const missingOperationMetadata = CONTROLLER_FILES.flatMap((file) => {
      const source = readBackendFile(file);
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
          missing.push(`${file}:${index + 1}:${lines[index].trim()}`);
        }
      }

      return missing;
    });

    expect(missingOperationMetadata).toEqual([]);
  });
});

function readBackendFile(path: string): string {
  const fullPath = resolve(process.cwd(), path);
  expect(existsSync(fullPath), `${path} should exist`).toBe(true);
  return readFileSync(fullPath, 'utf8');
}
