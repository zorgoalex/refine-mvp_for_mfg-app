import { describe, expect, it } from 'vitest';
import {
  assertUniqueReworkDetails,
  clarifyReworkReasonRequestSchema,
  normalizeReworkComment,
  parseReworkRequest,
  resolveReworkMode,
  reworkOutboxKey,
  startOrExtendReworkRequestSchema,
} from './order-rework';

describe('order rework domain rules', () => {
  it('maps order statuses to rework modes (D6) and refuses the rest', () => {
    expect(resolveReworkMode('legacy_6')).toBe('after_ready');
    expect(resolveReworkMode('legacy_7')).toBe('after_ready');
    expect(resolveReworkMode('legacy_2')).toBe('in_production');
    expect(resolveReworkMode('legacy_3')).toBe('in_production');
    expect(resolveReworkMode('legacy_4')).toBe('in_production');
    for (const code of ['legacy_1', 'legacy_5', 'legacy_8', 'crm_request', 'rework']) {
      expect(resolveReworkMode(code)).toBeNull();
    }
  });

  it('parses a start/extend request strictly', () => {
    const parsed = parseReworkRequest(startOrExtendReworkRequestSchema, {
      reasonId: 3,
      comment: ' брак ',
      details: [{ detailId: 10, productionStatusId: 1 }],
    });
    expect(parsed.details).toHaveLength(1);
    expect(() => parseReworkRequest(startOrExtendReworkRequestSchema, { details: [] })).toThrow(/Некорректные параметры/);
    expect(() => parseReworkRequest(startOrExtendReworkRequestSchema, {
      details: [{ detailId: 1, productionStatusId: 1, extra: true }],
    })).toThrow(/Некорректные параметры/);
    expect(() => parseReworkRequest(clarifyReworkReasonRequestSchema, { comment: 'x' })).toThrow(/Некорректные параметры/);
  });

  it('normalizes comments: trims, enforces the reason rule and the length limit', () => {
    expect(normalizeReworkComment('  брак  ', false)).toBe('брак');
    expect(normalizeReworkComment('   ', false)).toBeNull();
    expect(normalizeReworkComment(undefined, false)).toBeNull();
    expect(() => normalizeReworkComment('  ', true)).toThrow(/нужен комментарий/);
    expect(() => normalizeReworkComment('x'.repeat(2001), false)).toThrow(/длиннее 2000/);
    expect(normalizeReworkComment('x'.repeat(2000), true)).toHaveLength(2000);
  });

  it('rejects duplicate details', () => {
    expect(() => assertUniqueReworkDetails([{ detailId: 1 }, { detailId: 1 }])).toThrow(/несколько раз/);
    expect(() => assertUniqueReworkDetails([{ detailId: 1 }, { detailId: 2 }])).not.toThrow();
  });

  it('builds outbox keys carrying the order id, round and per-round sequence', () => {
    expect(reworkOutboxKey(42, 2, 'started', 1)).toBe('order:42:rework:2:started:1');
  });
});
