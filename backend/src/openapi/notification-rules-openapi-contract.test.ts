import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const contract = readFileSync(resolve(__dirname, '../../contracts/04-api-contract.openapi.yaml'), 'utf8');

function sectionBetween(start: string, end: string): string {
  const startIndex = contract.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = contract.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return contract.slice(startIndex, endIndex);
}

describe('notification rules OpenAPI contract', () => {
  it('documents projectId list filter as UUID or global', () => {
    const section = sectionBetween('  /api/v1/notification-rules:', '  /api/v1/notification-rules/{ruleId}:');

    expect(section).toContain('name: projectId');
    expect(section).toContain('oneOf:');
    expect(section).toContain('format: uuid');
    expect(section).toContain('global');
  });

  it('documents nullable projectId on rule and mutation schemas', () => {
    for (const schemaName of [
      'NotificationRule:',
      'CreateNotificationRuleRequest:',
      'UpdateNotificationRuleRequest:',
    ]) {
      const section = sectionBetween(`    ${schemaName}`, '\n\n    ');

      expect(section).toContain('projectId:');
      expect(section).toContain('format: uuid');
      expect(section).toContain('nullable: true');
    }
  });
});
