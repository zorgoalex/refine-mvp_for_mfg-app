import { describe, expect, it } from 'vitest';
import { commandKindOf, OPERATOR_COMMAND_SCHEMAS } from './onec-commands';
import { agentVersionAtLeast, etlAutoResetDue } from './onec-etl-stall';

describe('etl_reset (agent 1.3.17, agent-bridge to-erp/0219)', () => {
  it('is an admin command; payload: optional non-empty runIds (uuids) and a reason ≤ 500', () => {
    expect(commandKindOf('etl_reset')).toBe('admin');
    const schema = OPERATOR_COMMAND_SCHEMAS.etl_reset;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ runIds: ['bd162429-bdd2-41bb-b012-d0c6e835a2ef'], reason: 'manual' }).success).toBe(true);
    expect(schema.safeParse({ runIds: [] }).success).toBe(false);
    expect(schema.safeParse({ runIds: ['bd162429'] }).success).toBe(false);
    expect(schema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
    expect(schema.safeParse({ other: 1 }).success).toBe(false);
  });

  it('ERP sends it itself only after 24 h of a stall and only to an agent that executes it', () => {
    const now = new Date('2026-11-18T12:00:00Z');
    const day = new Date(now.getTime() - 24 * 3_600_000);
    const almost = new Date(now.getTime() - 23 * 3_600_000);
    expect(etlAutoResetDue(now, day, '1.3.17')).toBe(true);
    expect(etlAutoResetDue(now, day, '1.4.0')).toBe(true);
    expect(etlAutoResetDue(now, almost, '1.3.17')).toBe(false);
    expect(etlAutoResetDue(now, day, '1.3.16')).toBe(false);
    expect(etlAutoResetDue(now, day, null)).toBe(false);
    expect([agentVersionAtLeast('1.3.17', '1.3.17'), agentVersionAtLeast('1.10.0', '1.3.17'), agentVersionAtLeast('1.3', '1.3.17'), agentVersionAtLeast('x', '1.0')])
      .toEqual([true, true, false, false]);
  });
});
