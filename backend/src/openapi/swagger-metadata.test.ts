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

  it('documents Projects order status report response filter as a strict oneOf schema in Swagger metadata', () => {
    const controllerSource = readFileSync(
      resolve(backendRoot(), 'src/modules/projects/reporting/project-order-status-report.controller.ts'),
      'utf8',
    );

    expect(controllerSource).toContain('filter: {');
    expect(controllerSource).toContain('oneOf: [');
    expect(controllerSource).toContain("required: ['projectMode', 'projectIds', 'temporalMode']");
    expect(controllerSource).toContain("required: ['projectMode', 'projectIds', 'temporalMode', 'asOf']");
    expect(controllerSource).toContain("required: ['projectMode', 'projectIds', 'temporalMode', 'from', 'to']");
    expect(controllerSource).toContain('additionalProperties: false');
    expect(controllerSource).toContain("orderCount: { type: 'integer', minimum: 0 }");
    expect(controllerSource).toContain("schema: swaggerSchema(dateTimeQuerySwaggerSchema)");
  });

  it('documents Projects order relation counts response as a strict oneOf schema in Swagger metadata', () => {
    const controllerSource = readFileSync(
      resolve(backendRoot(), 'src/modules/projects/reporting/project-order-relation-counts-report.controller.ts'),
      'utf8',
    );

    expect(controllerSource).toContain('additionalProperties: false');
    expect(controllerSource).toContain('filter: {');
    expect(controllerSource).toContain('oneOf: [');
    expect(controllerSource).toContain("required: ['projectMode', 'projectIds', 'temporalMode']");
    expect(controllerSource).toContain("required: ['projectMode', 'projectIds', 'temporalMode', 'asOf']");
    expect(controllerSource).toContain("required: ['projectMode', 'projectIds', 'temporalMode', 'from', 'to']");
    expect(controllerSource).toContain("required: ['relationType', 'isPrimary', 'orderCount']");
    expect(controllerSource).toContain("relationType: { type: 'string', enum: ['main', 'secondary', 'reporting', 'billing', 'derived'] }");
    expect(controllerSource).toContain("isPrimary: { type: 'boolean' }");
    expect(controllerSource).toContain("orderCount: { type: 'integer', minimum: 0 }");
    expect(controllerSource).toContain("schema: swaggerSchema(dateTimeQuerySwaggerSchema)");
    expect(controllerSource).toContain("schema: { default: 'any' }");
    expect(controllerSource).toContain("schema: { default: 'current' }");
    expect(controllerSource).toContain('Comma-separated project UUIDs. Required unless projectMode is none.');
    expect(controllerSource).toContain('Returns only project-order relation aggregate counts and applied project report filter metadata.');
    expect(controllerSource).toContain("@ApiBearerAuth('bearerAuth')");
  });

  it('documents Projects production status counts response as a strict current-only schema in Swagger metadata', () => {
    const controllerSource = readFileSync(
      resolve(backendRoot(), 'src/modules/projects/reporting/project-production-status-counts-report.controller.ts'),
      'utf8',
    );

    expect(controllerSource).toContain("@ApiBearerAuth('bearerAuth')");
    expect(controllerSource).toContain('additionalProperties: false');
    expect(controllerSource).toContain('filter: {');
    expect(controllerSource).toContain('oneOf: [');
    expect(controllerSource).toContain("required: ['projectMode', 'temporalMode']");
    expect(controllerSource).toContain("required: ['projectMode', 'projectIds', 'temporalMode']");
    expect(controllerSource).toContain("schema: { default: 'any' }");
    expect(controllerSource).toContain("schema: { default: 'current' }");
    expect(controllerSource).toContain("enum: ['current']");
    expect(controllerSource).not.toContain("name: 'asOf'");
    expect(controllerSource).not.toContain("name: 'from'");
    expect(controllerSource).not.toContain("name: 'to'");
    expect(controllerSource).toContain(
      "required: ['productionStatusId', 'productionStatusCode', 'productionStatusName', 'orderCount']",
    );
    expect(controllerSource).toContain(
      'Returns only current orders.production_status_id aggregate counts and applied current project report filter metadata.',
    );
    expect(controllerSource).toContain("productionStatusId: { type: 'integer', nullable: true }");
    expect(controllerSource).toContain("productionStatusCode: { type: 'string', nullable: true }");
  });

  it('documents Projects deadline status counts response as a strict current-only schema in Swagger metadata', () => {
    const controllerSource = readFileSync(
      resolve(backendRoot(), 'src/modules/projects/reporting/project-deadline-status-counts-report.controller.ts'),
      'utf8',
    );

    expect(controllerSource).toContain("@ApiBearerAuth('bearerAuth')");
    expect(controllerSource).toContain("@Controller('projects/reports/deadline-status-counts')");
    expect(controllerSource).toContain('additionalProperties: false');
    expect(controllerSource).toContain('filter: {');
    expect(controllerSource).toContain('oneOf: [');
    expect(controllerSource).toContain("required: ['projectMode', 'temporalMode']");
    expect(controllerSource).toContain("required: ['projectMode', 'projectIds', 'temporalMode']");
    expect(controllerSource).toContain("schema: { default: 'any' }");
    expect(controllerSource).toContain("schema: { default: 'current' }");
    expect(controllerSource).toContain("enum: ['current']");
    expect(controllerSource).toContain("enum: ['any', 'all']");
    expect(controllerSource).not.toContain("name: 'asOf'");
    expect(controllerSource).not.toContain("name: 'from'");
    expect(controllerSource).not.toContain("name: 'to'");
    expect(controllerSource).toContain("required: ['deadlineStatus', 'deadlineCount']");
    expect(controllerSource).toContain(
      'Returns only current deadline_instances.status aggregate counts and the applied current project report filter.',
    );
    expect(controllerSource).toContain("deadlineStatus: { type: 'string', enum: DEADLINE_STATUSES }");
    expect(controllerSource).toContain("deadlineCount: { type: 'integer', minimum: 0 }");
  });

  it('documents Projects order created month counts response as a strict oneOf schema in Swagger metadata', () => {
    const controllerSource = readFileSync(
      resolve(backendRoot(), 'src/modules/projects/reporting/project-order-created-month-counts-report.controller.ts'),
      'utf8',
    );

    expect(controllerSource).toContain('additionalProperties: false');
    expect(controllerSource).toContain('filter: {');
    expect(controllerSource).toContain('oneOf: [');
    expect(controllerSource).toContain("required: ['projectMode', 'projectIds', 'temporalMode']");
    expect(controllerSource).toContain("required: ['projectMode', 'projectIds', 'temporalMode', 'asOf']");
    expect(controllerSource).toContain("required: ['projectMode', 'projectIds', 'temporalMode', 'from', 'to']");
    expect(controllerSource).toContain("required: ['month', 'orderCount']");
    expect(controllerSource).toContain("month: { type: 'string', format: 'date' }");
    expect(controllerSource).toContain("orderCount: { type: 'integer', minimum: 0 }");
    expect(controllerSource).toContain("schema: swaggerSchema(dateTimeQuerySwaggerSchema)");
    expect(controllerSource).toContain("schema: { default: 'any' }");
    expect(controllerSource).toContain("schema: { default: 'current' }");
    expect(controllerSource).toContain("name: 'createdFrom'");
    expect(controllerSource).toContain("name: 'createdTo'");
    expect(controllerSource).toContain('Returns only monthly order-created aggregate counts and applied project report filter metadata.');
    expect(controllerSource).toContain("@ApiBearerAuth('bearerAuth')");
  });

  it('documents Projects overview response and query metadata without projectIds in Swagger metadata', () => {
    const controllerSource = readFileSync(
      resolve(backendRoot(), 'src/modules/projects/overview/project-overview.controller.ts'),
      'utf8',
    );

    expect(controllerSource).toContain("@Controller('projects/:projectId/overview')");
    expect(controllerSource).toContain("@ApiBearerAuth('bearerAuth')");
    expect(controllerSource).toContain("operationId: 'getProjectOverview'");
    expect(controllerSource).toContain("name: 'temporalMode'");
    expect(controllerSource).toContain("schema: { default: 'current' }");
    expect(controllerSource).toContain("name: 'asOf'");
    expect(controllerSource).toContain("name: 'from'");
    expect(controllerSource).toContain("name: 'to'");
    expect(controllerSource).toContain("name: 'createdFrom'");
    expect(controllerSource).toContain("name: 'createdTo'");
    expect(controllerSource).not.toContain("name: 'projectIds'");
    expect(controllerSource).toContain('additionalProperties: false');
    expect(controllerSource).toContain("required: ['projectId', 'temporalMode']");
    expect(controllerSource).toContain("required: ['projectId', 'temporalMode', 'asOf']");
    expect(controllerSource).toContain("required: ['projectId', 'temporalMode', 'from', 'to']");
    expect(controllerSource).toContain("items: { type: 'string', enum: PROJECT_OVERVIEW_OMITTED }");
  });

  it('registers a runtime bearerAuth security scheme matching the static contract', () => {
    const swaggerSource = readFileSync(resolve(backendRoot(), 'src/config/swagger.ts'), 'utf8');

    expect(swaggerSource).toContain(".addBearerAuth(undefined, 'bearerAuth')");
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
