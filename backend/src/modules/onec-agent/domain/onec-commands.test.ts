import { describe, expect, it } from 'vitest';
import { commandPayloadStats, parseStrictJson } from '../canonical-json/canonical-json';
import { checkCommandPayload, commandKindOf, ONEC_COMMAND_PAYLOAD_LIMITS, OPERATOR_COMMAND_SCHEMAS } from './onec-commands';

describe('command payload policy = agent CommandPayloadPolicy', () => {
  it('counts depth and nodes exactly like the agent examples (to-erp/0011)', () => {
    expect(commandPayloadStats(parseStrictJson('{"a":{"b":1}}'))).toMatchObject({ depth: 2 });
    expect(commandPayloadStats(parseStrictJson('{"a":[1,2]}'))).toMatchObject({ nodes: 4 });
    expect(commandPayloadStats(parseStrictJson('{}'))).toEqual({ depth: 0, nodes: 1, maxObjectFields: 0 });
    // An empty deepest container is itself the deepest value.
    expect(commandPayloadStats(parseStrictJson('{"a":[]}'))).toMatchObject({ depth: 1, nodes: 2 });
  });

  const nest = (levels: number) => {
    let value: unknown = 1;
    for (let i = 0; i < levels; i += 1) value = { d: value };
    return value as Record<string, unknown>;
  };

  it('accepts exactly the limits and rejects one past each', () => {
    expect(checkCommandPayload(nest(31)).ok).toBe(true); // deepest value at depth 31
    expect(checkCommandPayload(nest(32))).toMatchObject({ ok: false, code: 'INVALID_PAYLOAD' });
    const wide = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`k${i}`, i]));
    expect(checkCommandPayload(wide).ok).toBe(true);
    expect(checkCommandPayload({ ...wide, k128: 1 })).toMatchObject({ ok: false, code: 'INVALID_PAYLOAD' });
    const nodes = { a: Array.from({ length: ONEC_COMMAND_PAYLOAD_LIMITS.maxNodes - 2 }, () => 0) };
    expect(checkCommandPayload(nodes).ok).toBe(true);
    expect(checkCommandPayload({ a: [...nodes.a, 0] })).toMatchObject({ ok: false, code: 'INVALID_PAYLOAD' });
    const exact = { s: 'x'.repeat(ONEC_COMMAND_PAYLOAD_LIMITS.maxBytes - '{"s":""}'.length) };
    expect(checkCommandPayload(exact)).toMatchObject({ ok: true, bytes: ONEC_COMMAND_PAYLOAD_LIMITS.maxBytes });
    expect(checkCommandPayload({ s: `${exact.s}x` })).toMatchObject({ ok: false, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects non-objects, fractional numbers and case-duplicate keys', () => {
    expect(checkCommandPayload([1])).toMatchObject({ ok: false, code: 'INVALID_PAYLOAD' });
    expect(checkCommandPayload({ n: 0.5 })).toMatchObject({ ok: false, code: 'INVALID_PAYLOAD' });
    expect(checkCommandPayload({ K: 1, k: 2 })).toMatchObject({ ok: false, code: 'INVALID_PAYLOAD' });
  });

  it('classifies command kinds and operator payload schemas', () => {
    expect(commandKindOf('start_full_sync')).toBe('admin');
    expect(commandKindOf('integration_probe')).toBe('business');
    expect(commandKindOf('reconcile_keys')).toBeNull();
    expect(OPERATOR_COMMAND_SCHEMAS.integration_probe!.safeParse({ marker: '' }).success).toBe(false);
    expect(OPERATOR_COMMAND_SCHEMAS.start_full_sync!.safeParse({ entities: [] }).success).toBe(true);
    expect(OPERATOR_COMMAND_SCHEMAS.pause_etl!.safeParse({ extra: 1 }).success).toBe(false);
  });
});
