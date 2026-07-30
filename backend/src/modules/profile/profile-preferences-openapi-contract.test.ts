import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contract = readFileSync(
  new URL('../../../contracts/04-api-contract.openapi.yaml', import.meta.url),
  'utf8',
);

describe('profile preferences OpenAPI contract', () => {
  it('requires UI variant in responses and accepts it in partial updates', () => {
    const userPreferences = sectionBetween(
      contract,
      '    UserPreferences:\n',
      '    UserPreferencesResponse:\n',
    );
    const updateRequest = sectionBetween(
      contract,
      '    UpdateUserPreferencesRequest:\n',
      '    ReferenceUsageRequest:\n',
    );

    expect(userPreferences).toMatch(/required:[\s\S]*- uiVariant/);
    expect(userPreferences).toMatch(
      /uiVariant:\s*\n\s*type: string\s*\n\s*enum: \[legacy, evolution, line, air\]/,
    );
    expect(updateRequest).toMatch(
      /uiVariant:\s*\n\s*type: string\s*\n\s*enum: \[legacy, evolution, line, air\]/,
    );
  });
});

function sectionBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}
