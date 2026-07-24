import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { relative, resolve, sep } from 'path';
import { describe, expect, it } from 'vitest';

const API_PREFIX = '/api/v1';
const ROUTE_DECORATOR_PATTERN = /^\s*@(Get|Post|Put|Patch|Delete)\(\s*(?:(['"`])([^'"`]*)\2)?\s*\)/gm;

describe('OpenAPI static contract route parity', () => {
  it('documents every implemented backend-owned /api/v1 route', () => {
    const contract = readOpenApiContract();
    const implementedRoutes = collectImplementedRoutes().sort();
    const documentedRoutes = collectDocumentedRoutes(contract).sort();

    expect(
      implementedRoutes.length,
      'Expected to discover backend-owned controller routes from source files',
    ).toBeGreaterThan(0);

    expect(
      documentedRoutes.filter((route) => !implementedRoutes.includes(route)),
      formatRouteDiff('Contract routes with no implemented controller route', implementedRoutes, documentedRoutes),
    ).toEqual([]);
    expect(
      implementedRoutes.filter((route) => !documentedRoutes.includes(route)),
      formatRouteDiff('Implemented controller routes missing from static OpenAPI contract', implementedRoutes, documentedRoutes),
    ).toEqual([]);
  });
});

function backendRoot(): string {
  const candidates = [resolve(process.cwd(), 'backend'), process.cwd()];
  const root = candidates.find((candidate) => existsSync(resolve(candidate, 'src/modules')));

  expect(root, 'Expected to find backend root from repo root or backend cwd').toBeDefined();

  return root as string;
}

function collectImplementedRoutes(): string[] {
  return backendControllerFiles().flatMap((file) => routesFromController(file));
}

function backendControllerFiles(): string[] {
  return walk(resolve(backendRoot(), 'src/modules'))
    .filter((file) => file.endsWith('controller.ts'))
    .filter((file) => !normalizePath(relative(backendRoot(), file)).startsWith('src/modules/health/'))
    .sort();
}

function routesFromController(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const routes: string[] = [];

  for (const section of controllerSections(source, file)) {
    for (const match of section.source.matchAll(ROUTE_DECORATOR_PATTERN)) {
      const method = match[1].toUpperCase();
      const routePath = match[3] ?? '';
      routes.push(`${method} ${toOpenApiPath(section.prefix, routePath)}`);
    }
  }

  return routes;
}

function controllerSections(source: string, file: string): Array<{ prefix: string; source: string }> {
  const matches = Array.from(source.matchAll(/@Controller\(\s*(?:(['"`])([^'"`]*)\1)?\s*\)/gm));

  expect(
    matches.length,
    `${normalizePath(relative(backendRoot(), file))} should declare a static @Controller(...) prefix`,
  ).toBeGreaterThan(0);

  return matches.map((match, index) => ({
    prefix: match[2] ?? '',
    source: source.slice(match.index ?? 0, matches[index + 1]?.index ?? source.length),
  }));
}

function toOpenApiPath(controllerPrefix: string, routePath: string): string {
  const joinedPath = [API_PREFIX, controllerPrefix, routePath]
    .filter((part) => part.length > 0)
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/\/:([^/]+)/g, '/{$1}');

  return joinedPath === '' ? '/' : joinedPath;
}

function readOpenApiContract(): string {
  const candidates = [
    resolve(process.cwd(), 'backend/contracts/04-api-contract.openapi.yaml'),
    resolve(process.cwd(), 'contracts/04-api-contract.openapi.yaml'),
  ];
  const contractPath = candidates.find((candidate) => existsSync(candidate));

  expect(contractPath).toBeDefined();

  return readFileSync(contractPath as string, 'utf8');
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = resolve(directory, entry);
    const stat = statSync(fullPath);

    return stat.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function collectDocumentedRoutes(contract: string): string[] {
  const routes: string[] = [];
  const lines = contract.split('\n');
  let currentPath: string | null = null;

  for (const line of lines) {
    const pathMatch = /^  (\/[^:]+):$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1].startsWith('/api/v1/') ? pathMatch[1] : null;
      continue;
    }

    const methodMatch = /^    (get|post|put|patch|delete):$/.exec(line);
    if (currentPath && methodMatch) {
      routes.push(`${methodMatch[1].toUpperCase()} ${currentPath}`);
    }
  }

  return routes;
}

function formatRouteDiff(title: string, implementedRoutes: string[], documentedRoutes: string[]): string {
  const implementedOnly = implementedRoutes.filter((route) => !documentedRoutes.includes(route));
  const documentedOnly = documentedRoutes.filter((route) => !implementedRoutes.includes(route));

  return [
    title,
    '',
    `Implemented controller routes (${implementedRoutes.length}):`,
    formatRouteList(implementedRoutes),
    '',
    `Missing from contract (${implementedOnly.length}):`,
    formatRouteList(implementedOnly),
    '',
    `Documented only (${documentedOnly.length}):`,
    formatRouteList(documentedOnly),
  ].join('\n');
}

function formatRouteList(routes: string[]): string {
  return routes.length > 0 ? routes.map((route) => `  - ${route}`).join('\n') : '  - none';
}

function normalizePath(path: string): string {
  return path.split(sep).join('/');
}
