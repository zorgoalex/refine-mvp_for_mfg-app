import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../common/errors/api-error';
import { parseGroupBatchLinkRequest } from './group-batch-link.dto';

describe('parseGroupBatchLinkRequest', () => {
  it('accepts dry-run batch link input', () => {
    expect(parseGroupBatchLinkRequest(validBody())).toEqual(validBody());
  });

  it('accepts write mode only with explicit selected-id intent', () => {
    expect(parseGroupBatchLinkRequest({
      ...validBody(),
      mode: 'write',
      writeIntent: 'explicit-selected-ids',
      idempotencyKey: 'groups-backfill-admin-2026-06-06:write:001',
    })).toMatchObject({
      mode: 'write',
      writeIntent: 'explicit-selected-ids',
      relationType: 'related',
    });

    expect(() => parseGroupBatchLinkRequest({
      ...validBody(),
      mode: 'write',
    })).toThrow(ApiError);
  });

  it('validates entity type and entity id shape from the Groups allowlist', () => {
    expect(() => parseGroupBatchLinkRequest({
      ...validBody(),
      items: [
        { entityId: 'not-a-number', reason: 'explicit reviewed mapping', confidence: 'explicit' },
      ],
    })).toThrow(ApiError);
  });

  it('rejects group inference fields', () => {
    expect(() => parseGroupBatchLinkRequest({
      ...validBody(),
      groupName: 'Без проекта',
    })).toThrow(ApiError);
  });
});

function validBody() {
  return {
    mode: 'dry-run' as const,
    fixtureKey: 'groups-backfill-admin-2026-06-06',
    idempotencyKey: 'groups-backfill-admin-2026-06-06:dry-run:001',
    entityType: 'order' as const,
    relationType: 'related',
    source: { type: 'operator_csv', reference: 'reviewed-input-001' },
    items: [
      { entityId: '11195', reason: 'explicit reviewed mapping', confidence: 'explicit' },
    ],
  };
}
