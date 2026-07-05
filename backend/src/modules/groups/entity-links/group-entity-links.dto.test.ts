import { describe, expect, it } from 'vitest';

import {
  GROUP_ENTITY_TYPE_CODES,
  parseReplaceGroupEntityLinksRequest,
} from './group-entity-links.dto';

describe('group entity link DTO parsing', () => {
  it('accepts bounded allowlist links', () => {
    expect(parseReplaceGroupEntityLinksRequest({
      idempotencyKey: 'key-1',
      links: [{ entityType: 'client', entityId: '42', relationType: 'related', metadata: {} }],
      reason: 'test',
    }).links[0]).toMatchObject({ entityType: 'client', entityId: '42' });
  });

  it('normalizes defaults and trimmed string fields', () => {
    expect(parseReplaceGroupEntityLinksRequest({
      idempotencyKey: ' key-1 ',
      links: [{ entityType: 'workshop', entityId: '  77  ' }],
      reason: ' reason ',
    })).toEqual({
      idempotencyKey: 'key-1',
      links: [{
        entityType: 'workshop',
        entityId: '77',
        relationType: 'related',
        metadata: {},
      }],
      reason: 'reason',
    });
  });

  it('exports only the accepted first entity allowlist', () => {
    expect([...GROUP_ENTITY_TYPE_CODES].sort()).toEqual([
      'client',
      'deadline_instance',
      'employee',
      'order',
      'user',
      'workshop',
    ]);
  });

  it('rejects arbitrary entity types and duplicate current relations', () => {
    expect(() => parseReplaceGroupEntityLinksRequest({
      idempotencyKey: 'key-1',
      links: [{ entityType: 'payments', entityId: '1' }],
    })).toThrow(/VALIDATION_ERROR/);
    expect(() => parseReplaceGroupEntityLinksRequest({
      idempotencyKey: 'key-1',
      links: [
        { entityType: 'client', entityId: '42', relationType: 'related' },
        { entityType: 'client', entityId: '42', relationType: 'related' },
      ],
    })).toThrow(/Duplicate/);
  });

  it('rejects invalid relation type, blank ids, and oversized link sets', () => {
    expect(() => parseReplaceGroupEntityLinksRequest({
      idempotencyKey: 'key-1',
      links: [{ entityType: 'client', entityId: '42', relationType: 'bad-value' }],
    })).toThrow(/VALIDATION_ERROR/);
    expect(() => parseReplaceGroupEntityLinksRequest({
      idempotencyKey: 'key-1',
      links: [{ entityType: 'client', entityId: ' ' }],
    })).toThrow(/VALIDATION_ERROR/);
    expect(() => parseReplaceGroupEntityLinksRequest({
      idempotencyKey: 'key-1',
      links: Array.from({ length: 501 }, (_, index) => ({
        entityType: 'client',
        entityId: String(index),
      })),
    })).toThrow(/VALIDATION_ERROR/);
  });
});
