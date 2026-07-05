import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('workos identity OpenAPI contract', () => {
  it('declares the new WorkOS identity routes and removes the legacy link route/schema', () => {
    const contract = readOpenApiContract();

    expect(contract).toContain('  /api/v1/auth/workos/links:');
    expect(contract).toContain('  /api/v1/auth/workos/links/{identityId}:');
    expect(contract).toContain('  /api/v1/auth/workos/admin/users/{userId}/links:');
    expect(contract).toContain('  /api/v1/auth/workos/admin/users/{userId}/links/{identityId}:');
    expect(contract).not.toContain('  /api/v1/auth/workos/link:');
    expect(contract).not.toContain('    WorkosLinkStatusResponse:');
  });

  it('documents current-user WorkOS links list with the expected response schema shape', () => {
    const contract = readOpenApiContract();
    const listSection = sectionBetween(
      contract,
      '  /api/v1/auth/workos/links:',
      '  /api/v1/auth/workos/links/{identityId}:',
    );
    const listResponseSchema = sectionBetween(
      contract,
      '    WorkosLinkListResponse:',
      '    WorkosAdminUnlinkRequest:',
    );

    expect(listSection).toContain('operationId: authWorkosListLinks');
    expect(listSection).toContain("$ref: '#/components/schemas/WorkosLinkListResponse'");
    expect(listResponseSchema).toContain('links:');
    expect(listResponseSchema).toContain('identityId:');
    expect(listResponseSchema).toContain('authMethod:');
    expect(listResponseSchema).toContain('emailAtLink:');
    expect(listResponseSchema).toContain('linkedAt:');
    expect(listResponseSchema).toContain('lastLoginAt:');
  });

  it('documents current-user unlink with password confirmation and explicit responses', () => {
    const contract = readOpenApiContract();
    const unlinkSection = sectionBetween(
      contract,
      '  /api/v1/auth/workos/links/{identityId}:',
      '  /api/v1/auth/workos/admin/users/{userId}/links:',
    );
    const unlinkRequestSchema = sectionBetween(
      contract,
      '    WorkosUnlinkRequest:',
      '    WorkosUnlinkResponse:',
    );

    expect(unlinkSection).toContain('operationId: authWorkosUnlinkOne');
    expect(unlinkSection).toContain('name: identityId');
    expect(unlinkSection).toContain("$ref: '#/components/schemas/WorkosUnlinkRequest'");
    expect(unlinkRequestSchema).toContain('- password');
    expect(unlinkRequestSchema).toContain('password:');
    for (const status of ["'200':", "'401':", "'404':", "'409':", "'422':"]) {
      expect(unlinkSection).toContain(status);
    }
  });

  it('documents admin WorkOS list and unlink routes with target-user params and admin request schema', () => {
    const contract = readOpenApiContract();
    const adminListSection = sectionBetween(
      contract,
      '  /api/v1/auth/workos/admin/users/{userId}/links:',
      '  /api/v1/auth/workos/admin/users/{userId}/links/{identityId}:',
    );
    const adminUnlinkSection = sectionBetween(
      contract,
      '  /api/v1/auth/workos/admin/users/{userId}/links/{identityId}:',
      '  /api/v1/me:',
    );
    const adminUnlinkRequestSchema = sectionBetween(
      contract,
      '    WorkosAdminUnlinkRequest:',
      '    WorkosUnlinkRequest:',
    );

    expect(adminListSection).toContain('operationId: authWorkosAdminListLinks');
    expect(adminListSection).toContain('name: userId');
    expect(adminListSection).toContain("$ref: '#/components/schemas/WorkosLinkListResponse'");
    for (const status of ["'200':", "'403':", "'404':"]) {
      expect(adminListSection).toContain(status);
    }

    expect(adminUnlinkSection).toContain('operationId: authWorkosAdminUnlinkOne');
    expect(adminUnlinkSection).toContain('name: userId');
    expect(adminUnlinkSection).toContain('name: identityId');
    expect(adminUnlinkSection).toContain("$ref: '#/components/schemas/WorkosAdminUnlinkRequest'");
    expect(adminUnlinkRequestSchema).toContain('reason:');
    expect(adminUnlinkRequestSchema).not.toContain('required:');
    for (const status of ["'200':", "'403':", "'404':", "'409':", "'422':"]) {
      expect(adminUnlinkSection).toContain(status);
    }
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
