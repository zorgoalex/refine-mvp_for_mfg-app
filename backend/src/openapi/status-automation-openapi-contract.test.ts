import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATUS_AUTOMATION_EVENTS } from '../modules/status-automation/domain/status-automation-events';

const contract = readFileSync(resolve(__dirname, '../../contracts/04-api-contract.openapi.yaml'), 'utf8');

function sectionBetween(start: string, end: string): string {
  const startIndex = contract.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = contract.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return contract.slice(startIndex, endIndex);
}

describe('status automation OpenAPI contract', () => {
  const conditions = sectionBetween('    StatusAutomationConditionsDto:', '    StatusAutomationEventTypeDto:');
  const eventType = sectionBetween('    StatusAutomationEventTypeDto:', '    StatusAutomationActionConfigDto:');
  const allowedConditions = eventType.slice(eventType.indexOf('allowedConditions:'), eventType.indexOf('allowedActions:'));
  const allowedActions = eventType.slice(eventType.indexOf('allowedActions:'));

  it('documents every condition and action the event catalog returns', () => {
    for (const event of STATUS_AUTOMATION_EVENTS) {
      for (const condition of event.allowedConditions) {
        expect(conditions, `${event.eventType}: ${condition}`).toContain(`        ${condition}:`);
        expect(allowedConditions, `${event.eventType}: ${condition}`).toContain(`- ${condition}\n`);
      }
      for (const action of event.allowedActions) {
        expect(allowedActions, `${event.eventType}: ${action}`).toContain(`- ${action}\n`);
      }
    }
  });
});
