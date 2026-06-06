import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../common/errors/api-error';
import { parseProjectBatchLinkRequest } from './project-batch-link.dto';

describe('parseProjectBatchLinkRequest', () => {
  it('accepts dry-run batch link input', () => {
    expect(parseProjectBatchLinkRequest({
      mode: 'dry-run',
      fixtureKey: 'projects-backfill-admin-2026-06-06',
      idempotencyKey: 'projects-backfill-admin-2026-06-06:dry-run:001',
      entityType: 'order',
      source: { type: 'operator_csv', reference: 'reviewed-input-001' },
      items: [
        { entityId: '11195', reason: 'explicit reviewed mapping', confidence: 'explicit' },
      ],
    })).toEqual({
      mode: 'dry-run',
      fixtureKey: 'projects-backfill-admin-2026-06-06',
      idempotencyKey: 'projects-backfill-admin-2026-06-06:dry-run:001',
      entityType: 'order',
      source: { type: 'operator_csv', reference: 'reviewed-input-001' },
      items: [
        { entityId: '11195', reason: 'explicit reviewed mapping', confidence: 'explicit' },
      ],
    });
  });

  it('rejects write mode fail-closed', () => {
    expect(() => parseProjectBatchLinkRequest({
      mode: 'write',
      fixtureKey: 'projects-backfill-admin-2026-06-06',
      idempotencyKey: 'projects-backfill-admin-2026-06-06:write:001',
      entityType: 'order',
      source: { type: 'operator_csv', reference: 'reviewed-input-001' },
      items: [],
    })).toThrow(ApiError);
  });

  it('validates entity type and entity id shape from the Projects allowlist', () => {
    expect(() => parseProjectBatchLinkRequest({
      mode: 'dry-run',
      fixtureKey: 'projects-backfill-admin-2026-06-06',
      idempotencyKey: 'projects-backfill-admin-2026-06-06:dry-run:001',
      entityType: 'order',
      source: { type: 'operator_csv', reference: 'reviewed-input-001' },
      items: [
        { entityId: 'not-a-number', reason: 'explicit reviewed mapping', confidence: 'explicit' },
      ],
    })).toThrow(ApiError);
  });
});
