import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../common/errors/api-error';
import { parseProjectBatchLinkRequest } from './project-batch-link.dto';

describe('parseProjectBatchLinkRequest', () => {
  it('accepts dry-run batch link input', () => {
    expect(parseProjectBatchLinkRequest(validBody())).toEqual(validBody());
  });

  it('accepts write mode only with explicit selected-id intent', () => {
    expect(parseProjectBatchLinkRequest({
      ...validBody(),
      mode: 'write',
      writeIntent: 'explicit-selected-ids',
      idempotencyKey: 'projects-backfill-admin-2026-06-06:write:001',
    })).toMatchObject({
      mode: 'write',
      writeIntent: 'explicit-selected-ids',
      relationType: 'related',
    });

    expect(() => parseProjectBatchLinkRequest({
      ...validBody(),
      mode: 'write',
    })).toThrow(ApiError);
  });

  it('validates entity type and entity id shape from the Projects allowlist', () => {
    expect(() => parseProjectBatchLinkRequest({
      ...validBody(),
      items: [
        { entityId: 'not-a-number', reason: 'explicit reviewed mapping', confidence: 'explicit' },
      ],
    })).toThrow(ApiError);
  });

  it('rejects project inference fields', () => {
    expect(() => parseProjectBatchLinkRequest({
      ...validBody(),
      projectName: 'Без проекта',
    })).toThrow(ApiError);
  });
});

function validBody() {
  return {
    mode: 'dry-run' as const,
    fixtureKey: 'projects-backfill-admin-2026-06-06',
    idempotencyKey: 'projects-backfill-admin-2026-06-06:dry-run:001',
    entityType: 'order' as const,
    relationType: 'related',
    source: { type: 'operator_csv', reference: 'reviewed-input-001' },
    items: [
      { entityId: '11195', reason: 'explicit reviewed mapping', confidence: 'explicit' },
    ],
  };
}
