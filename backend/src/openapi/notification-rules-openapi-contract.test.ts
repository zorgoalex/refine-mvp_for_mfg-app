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
  it('documents groupId list filter as UUID or global', () => {
    const section = sectionBetween('  /api/v1/notification-rules:', '  /api/v1/notification-rules/{ruleId}:');

    expect(section).toContain('name: groupId');
    expect(section).toContain('oneOf:');
    expect(section).toContain('format: uuid');
    expect(section).toContain('global');
  });

  it('documents nullable groupId on rule and mutation schemas', () => {
    for (const schemaName of [
      'NotificationRule:',
      'CreateNotificationRuleRequest:',
      'UpdateNotificationRuleRequest:',
    ]) {
      const section = sectionBetween(`    ${schemaName}`, '\n\n    ');

      expect(section).toContain('groupId:');
      expect(section).toContain('format: uuid');
      expect(section).toContain('nullable: true');
    }
  });

  it('documents deadlineEntityTypes on notification rule conditions', () => {
    const section = sectionBetween('    NotificationRuleConditions:', '\n\n    NotificationRuleRecipients:');
    const deadlineEntityTypesSection = sectionBetweenIn(
      section,
      '        deadlineEntityTypes:',
      '        excludeOrderStatusIds:',
    );

    expect(deadlineEntityTypesSection).toContain('type: array');
    expect(deadlineEntityTypesSection).toContain('minItems: 1');
    expect(deadlineEntityTypesSection).toContain('items:');
    expect(deadlineEntityTypesSection).toContain('type: string');
    expect(extractEnumValues(deadlineEntityTypesSection)).toEqual(['order', 'order_stage']);
    expect(section).toContain('requireCurrentDeadlineEvent:');
    expect(section).toContain('type: boolean');
  });

  it('documents deadline condition support on notification event metadata', () => {
    const section = sectionBetween('    NotificationEventType:', '\n\n    NotificationEventTypeListResponse:');

    expect(section).toContain('- supportsDeadlineConditions');
    expect(section).toContain('supportsDeadlineConditions:');
    expect(section).toContain('type: boolean');
  });

  it('documents extensible notification channels on rules and mutations', () => {
    for (const schemaName of [
      'NotificationRule:',
      'CreateNotificationRuleRequest:',
      'UpdateNotificationRuleRequest:',
    ]) {
      const section = sectionBetween(`    ${schemaName}`, '\n\n    ');
      const channels = sectionBetweenIn(section, '        channels:', '        conditions:');
      expect(channels).toContain('type: array');
      expect(channels).toContain('minItems: 1');
      expect(Array.from(new Set(extractEnumValues(channels)))).toEqual(['in_app', 'telegram']);
    }
  });
});

function sectionBetweenIn(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function extractEnumValues(section: string): string[] {
  return section
    .split('\n')
    .map((line) => /^\s+-\s+(.+)$/.exec(line)?.[1])
    .filter((value): value is string => value != null);
}
