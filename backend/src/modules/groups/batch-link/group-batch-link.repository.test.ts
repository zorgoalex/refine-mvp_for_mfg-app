import { describe, expect, it } from 'vitest';

import type { DatabaseClient } from '../../../database/database.types';
import { PgGroupBatchLinkRepository } from './group-batch-link.repository';

const groupId = '11111111-1111-4111-8111-111111111111';

describe('PgGroupBatchLinkRepository', () => {
  it('uses group and entity existence SELECT queries only', async () => {
    const queries: string[] = [];
    const repository = new PgGroupBatchLinkRepository({
      async query(text: string) {
        queries.push(text);
        if (text.includes('group_groups')) return { rows: [{ id: groupId }] };
        if (text.includes('FROM public.orders')) return { rows: [{ entity_id: '11195', display_label: 'Order 11195' }] };
        return { rows: [] };
      },
    } as unknown as DatabaseClient);

    await expect(repository.dryRun({
      currentUser: { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions: ['groups.manage_links', 'orders.view'] },
      groupId,
      requestId: 'req-1',
      dto: {
        mode: 'dry-run',
        fixtureKey: 'groups-backfill-admin-2026-06-06',
        idempotencyKey: 'groups-backfill-admin-2026-06-06:dry-run:001',
        entityType: 'order',
        relationType: 'related',
        source: { type: 'operator_csv', reference: 'reviewed-input-001' },
        items: [{ entityId: '11195', reason: 'explicit reviewed mapping', confidence: 'explicit' }],
      },
    })).resolves.toMatchObject({
      groupId,
      mode: 'dry-run',
      summary: { proposed: 1, skipped: 0, conflicts: 0, sampledEvidenceRows: 1 },
      sampleEvidence: [{
        groupId,
        idempotencyKey: 'groups-backfill-admin-2026-06-06:dry-run:001',
        requestId: 'req-1',
        actorUserId: '1',
        actorUsername: 'tester',
      }],
      writeEnabled: false,
    });

    const sql = queries.join('\n').toLowerCase();
    expect(sql).toContain('select');
    expect(sql).not.toMatch(/\b(insert|update|delete)\b/);
    expect(sql).not.toContain('group_entity_links');
    expect(sql).not.toContain('audit_log');
    expect(sql).not.toContain('outbox_events');
    expect(sql).not.toContain('notifications');
    expect(sql).not.toContain('command_idempotency_keys');
    expect(sql).not.toMatch(/\bfor\s+(?:key\s+)?share\b/);
    expect(sql).not.toMatch(/\bfor\s+update\b/);
  });

  it('skips missing entities without throwing', async () => {
    const repository = new PgGroupBatchLinkRepository({
      async query(text: string) {
        if (text.includes('group_groups')) return { rows: [{ id: groupId }] };
        return { rows: [] };
      },
    } as unknown as DatabaseClient);

    await expect(repository.dryRun({
      currentUser: { id: '1', username: 'tester', role: 'admin', roleId: 1, permissions: ['groups.manage_links', 'orders.view'] },
      groupId,
      requestId: 'req-1',
      dto: {
        mode: 'dry-run',
        fixtureKey: 'groups-backfill-admin-2026-06-06',
        idempotencyKey: 'groups-backfill-admin-2026-06-06:dry-run:001',
        entityType: 'order',
        relationType: 'related',
        source: { type: 'operator_csv', reference: 'reviewed-input-001' },
        items: [{ entityId: '11195', reason: 'explicit reviewed mapping', confidence: 'explicit' }],
      },
    })).resolves.toMatchObject({
      summary: { proposed: 0, skipped: 1, conflicts: 0, sampledEvidenceRows: 1 },
      proposals: [],
      skipped: [{ entityType: 'order', entityId: '11195', reasonCode: 'entity_not_found' }],
      writeEnabled: false,
    });
  });
});
