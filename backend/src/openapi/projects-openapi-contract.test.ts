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
