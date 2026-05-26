import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('projects OpenAPI contract', () => {
  it('declares project routes and top-level Projects tag', () => {
    const contract = readOpenApiContract();
    const tagsSection = sectionBetween(contract, 'tags:\n', '\npaths:');

    expect(tagsSection).toContain('  - name: Projects');
    expect(contract).toContain('  /api/v1/projects:');
    expect(contract).toContain('  /api/v1/projects/lookup:');
    expect(contract).toContain('  /api/v1/projects/{projectId}:');
  });

  it('documents get project bad request and list pagination totalPages', () => {
    const contract = readOpenApiContract();
    const listSection = sectionBetween(
      contract,
      '  /api/v1/projects:',
      '  /api/v1/projects/lookup:',
    );
    const getSection = sectionBetween(
      contract,
      '  /api/v1/projects/{projectId}:',
      '  /api/v1/users:',
    );
    const listResponseSchema = sectionBetween(
      contract,
      '    ProjectListResponse:',
      '    Pagination:',
    );

    expect(listSection).toContain("$ref: '#/components/schemas/ProjectListResponse'");
    expect(listResponseSchema).toContain('- totalPages');
    expect(listResponseSchema).toContain('totalPages:');
    expect(getSection).toContain("'400':");
    expect(getSection).toContain("$ref: '#/components/responses/BadRequest'");
  });

  it('documents project write endpoints, permissions, and request schemas', () => {
    const contract = readOpenApiContract();
    const projectsSection = sectionBetween(
      contract,
      '  /api/v1/projects:',
      '  /api/v1/projects/lookup:',
    );
    const projectByIdSection = sectionBetween(
      contract,
      '  /api/v1/projects/{projectId}:',
      '  /api/v1/users:',
    );
    const createSchema = sectionBetween(
      contract,
      '    CreateProjectRequest:',
      '    UpdateProjectRequest:',
    );
    const updateSchema = sectionBetween(
      contract,
      '    UpdateProjectRequest:',
      '    Project:',
    );

    expect(projectsSection).toContain('post:');
    expect(projectsSection).toContain('operationId: createProject');
    expect(projectsSection).toContain('x-permission: projects.create');
    expect(projectsSection).toContain("$ref: '#/components/schemas/CreateProjectRequest'");
    expect(projectByIdSection).toContain('patch:');
    expect(projectByIdSection).toContain('operationId: updateProject');
    expect(projectByIdSection).toContain('x-permission: projects.update');
    expect(projectByIdSection).toContain('delete:');
    expect(projectByIdSection).toContain('operationId: archiveProject');
    expect(projectByIdSection).toContain('x-permission: projects.archive');
    expect(createSchema).toContain('- code');
    expect(createSchema).toContain('pattern: ^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$');
    expect(createSchema).toContain('maxLength: 256');
    expect(updateSchema).toContain('minProperties: 1');
    expect(createSchema).toContain('enum: [draft, active, paused, completed]');
    expect(updateSchema).toContain('enum: [draft, active, paused, completed]');
    expect(updateSchema).not.toContain('enum: [draft, active, paused, completed, archived]');
  });
});

function readOpenApiContract(): string {
  const candidates = [
    resolve(process.cwd(), 'backend/contracts/04-api-contract.openapi.yaml'),
    resolve(process.cwd(), 'contracts/04-api-contract.openapi.yaml'),
  ];
  const contractPath = candidates.find((candidate) => existsSync(candidate));

  expect(contractPath).toBeDefined();

  return readFileSync(contractPath as string, 'utf8');
}

function sectionBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);

  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);

  return source.slice(startIndex, endIndex);
}
