import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const contract = readFileSync(resolve(__dirname, '../../contracts/04-api-contract.openapi.yaml'), 'utf8');

describe('deadline transition rules OpenAPI contract', () => {
  it('documents the complete transition-rule CRUD surface', () => {
    const collection = sectionBetween(
      '  /api/v1/deadline-transition-rules:',
      '  /api/v1/deadline-transition-rules/{actionRuleId}:',
    );
    const item = sectionBetween(
      '  /api/v1/deadline-transition-rules/{actionRuleId}:',
      '  /api/v1/deadline-worker/process-due-now:',
    );

    expect(collection).toContain('operationId: listGlobalDeadlineTransitionRules');
    expect(collection).toContain('operationId: createGlobalDeadlineTransitionRule');
    expect(item).toContain('operationId: updateGlobalDeadlineTransitionRule');
    expect(item).toContain('operationId: deleteGlobalDeadlineTransitionRule');
    expect(collection).toContain('x-permission: deadlines.actions.manage');
    expect(item).toContain('x-permission: deadlines.actions.manage');
  });

  it('documents named policy-scoped enabled rules and stale-safe mutations', () => {
    const create = schemaSection('CreateGlobalTransitionRuleRequest');
    const update = schemaSection('UpdateGlobalTransitionRuleRequest');
    const remove = schemaSection('DeleteGlobalTransitionRuleRequest');

    expect(create).toContain('- ruleName');
    expect(create).toContain('- targetOrderStatusId');
    expect(create).toContain('- allowedFromOrderStatusIds');
    expect(create).toContain('policyId:');
    expect(create).toContain('deadlineTarget:');
    expect(create).toContain('delayAfterDeadline:');
    expect(create).toContain('nullable: true');
    expect(create).toContain('isEnabled:');
    expect(create).toContain('requireCurrentDeadlineEvent:');
    expect(update).toContain('- expectedUpdatedAt');
    expect(update).toContain('- reason');
    expect(update).toContain('deadlineTarget:');
    expect(update).toContain('delayAfterDeadline:');
    expect(remove).toContain('- expectedUpdatedAt');
    expect(remove).toContain('- reason');
  });

  it('documents final-order and production-stage deadline selectors', () => {
    const target = schemaSection('DeadlineActionRuleDeadlineTarget');

    expect(target).toContain('- all_order_deadlines');
    expect(target).toContain('- final_order');
    expect(target).toContain('- production_stage');
    expect(target).toContain('productionStatusId:');
  });

  it('documents optional days, hours and minutes after a deadline', () => {
    const delay = schemaSection('DeadlineActionRuleDelayAfterDeadline');

    expect(delay).toContain('- days');
    expect(delay).toContain('- hours');
    expect(delay).toContain('- minutes');
    expect(delay).toContain('maximum: 23');
    expect(delay).toContain('maximum: 59');
  });

  it('documents readiness and exact-deadline manual canary targeting', () => {
    const readiness = schemaSection('DeadlineTransitionRulesReadiness');
    const manualWorker = routeSection('/api/v1/deadline-worker/process-due-now');
    const scheduledWorker = routeSection('/api/v1/deadline-worker/process-due-scheduled');

    expect(readiness).toContain('- manualMutationReady');
    expect(readiness).toContain('- inProcessAutomaticReady');
    expect(readiness).toContain('- externalSchedulerOwnerSelected');
    expect(manualWorker).toContain('deadlineId:');
    expect(manualWorker).toContain('format: uuid');
    expect(scheduledWorker).not.toContain('deadlineId:');
  });
});

function schemaSection(name: string): string {
  return sectionBetween(`    ${name}:`, '\n\n    ');
}

function routeSection(path: string): string {
  const start = `  ${path}:`;
  const startIndex = contract.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = contract.indexOf('\n  /api/v1/', startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return contract.slice(startIndex, endIndex);
}

function sectionBetween(start: string, end: string): string {
  const startIndex = contract.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = contract.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return contract.slice(startIndex, endIndex);
}
