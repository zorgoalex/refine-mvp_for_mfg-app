import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// Коды успеха маршрутов склада в статическом контракте совпадают с контроллером: `@Post` без
// `@HttpCode` отвечает 201, с `@HttpCode(n)` — n, остальные методы — 200 (route-parity этого не ловит).
function file(...candidates: string[]): string {
  const found = candidates.map((candidate) => resolve(process.cwd(), candidate)).find((candidate) => existsSync(candidate));
  expect(found, candidates.join(' | ')).toBeDefined();
  return readFileSync(found as string, 'utf8');
}

describe('inventory OpenAPI success codes', () => {
  it('match the controller decorators', () => {
    const controller = file('backend/src/modules/inventory/http/inventory.controller.ts', 'src/modules/inventory/http/inventory.controller.ts');
    const contract = load(file('backend/contracts/04-api-contract.openapi.yaml', 'contracts/04-api-contract.openapi.yaml')) as {
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };
    const routes: Array<{ method: string; path: string; code: string }> = [];
    // Декораторы метода — подряд идущие строки, начинающиеся с «@».
    const lines = controller.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const route = /^\s*@(Get|Post|Patch|Put|Delete)\('([^']*)'\)/.exec(lines[index]);
      if (!route) continue;
      let start = index;
      while (start > 0 && lines[start - 1].trim().startsWith('@')) start -= 1;
      let end = index;
      while (end + 1 < lines.length && lines[end + 1].trim().startsWith('@')) end += 1;
      const block = lines.slice(start, end + 1).join('\n');
      const httpCode = /@HttpCode\((\d{3})\)/.exec(block)?.[1];
      const method = route[1].toLowerCase();
      const path = `/api/v1/${route[2].replace(/:([A-Za-z]+)/g, '{$1}')}`;
      routes.push({ method, path, code: httpCode ?? (method === 'post' ? '201' : '200') });
    }
    expect(routes.length).toBeGreaterThanOrEqual(15);
    for (const route of routes) {
      const responses = contract.paths[route.path]?.[route.method]?.responses ?? {};
      const success = Object.keys(responses).filter((code) => /^2\d\d$/.test(code));
      expect({ route: `${route.method.toUpperCase()} ${route.path}`, success }).toEqual({ route: `${route.method.toUpperCase()} ${route.path}`, success: [route.code] });
    }
  });
});
