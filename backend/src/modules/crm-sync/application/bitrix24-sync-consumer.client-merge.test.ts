import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { OutboxEventRecord } from '../../notifications-engine/domain/outbox-event.types';
import { Bitrix24ApiError, type Bitrix24ApiPort } from '../adapters/bitrix24-api-client';
import type { PgCrmSyncMappingRepository } from '../adapters/pg-crm-sync-mapping-repository';
import { Bitrix24SyncConsumer, CrmSyncAuditOnlyError } from './bitrix24-sync-consumer';
import type { CrmSourcePort, MappingRow } from './crm-sync.types';

const contact: MappingRow = {
  entityType: 'client', erpId: '7', bitrixObject: 'contact', bitrixId: '55',
  parentErpId: null, status: 'active', lastHash: 'h',
};

function mergeEvent(
  kind: 'merged' | 'merge_undone' = 'merged',
  payload: Record<string, unknown> = { mergeId: 12, mergedClientId: 7, survivorId: 9 },
): OutboxEventRecord {
  return {
    outboxEventId: 'event-merge',
    eventType: `crm.sync.client.${kind}`,
    aggregateType: 'crm_sync',
    aggregateId: '7',
    payload,
    attempts: 0,
    createdAt: '2026-10-22T10:00:00.000Z',
  };
}

function harness(input: {
  mapping?: MappingRow | null;
  comments?: Array<{ id: string; comment: string }>;
  complete?: boolean;
  addError?: Error;
  noComments?: boolean;
  mergeStatus?: 'done' | 'undone' | null;
  client?: Record<string, unknown>;
  /** Client rows returned one after the other (the read under the merge key comes second). */
  clients?: Array<Record<string, unknown>>;
  updateError?: Error;
} = {}) {
  const added: Array<{ entity: string; id: string; comment: string }> = [];
  const lockQuery = vi.fn(async () => ({ rows: [] }));
  const upsertSuccess = vi.fn(async () => true);
  const listTimelineComments = vi.fn(async () => ({ comments: input.comments ?? [], complete: input.complete ?? true }));
  const addTimelineComment = vi.fn(async (entity: string, id: string, comment: string) => {
    if (input.addError) throw input.addError;
    added.push({ entity, id, comment });
    return '901';
  });
  const bitrix = {
    withRequestGuard: (_guard: unknown, operation: () => Promise<unknown>) => operation(),
    updateCrmItem: vi.fn(async () => { if (input.updateError) throw input.updateError; }),
    createCrmItem: vi.fn(async () => '777'),
    deleteCrmItem: vi.fn(),
    findCrmItemByOrigin: vi.fn(async () => null),
    ...(input.noComments ? {} : { listTimelineComments, addTimelineComment }),
  } as unknown as Bitrix24ApiPort;
  const source = {
    getClientById: vi.fn(async (id: string) => ({
      clientId: id, clientName: 'ТОО «Остающийся» https://evil.example/x', personType: 'legal',
      notes: null, isActive: true, phones: [], ...(input.clients?.shift() ?? input.client),
    })),
    getClientMergeStatus: vi.fn(async () => (input.mergeStatus === undefined ? 'done' : input.mergeStatus)),
  } as unknown as CrmSourcePort;
  const mapping = {
    get: vi.fn(async () => (input.mapping === undefined ? contact : input.mapping)),
    upsertSuccess,
  } as unknown as PgCrmSyncMappingRepository;
  const consumer = new Bitrix24SyncConsumer({
    source,
    bitrix,
    mapping,
    db: { transaction: vi.fn(async (handler: (tx: unknown) => Promise<unknown>) => handler({ query: lockQuery })) } as unknown as DatabaseService,
    options: { erpBaseUrl: 'https://erp.example', currencyId: 'KZT', assignedById: 1, paySystemId: 6 },
  });
  return { consumer, bitrix, added, listTimelineComments, addTimelineComment, lockQuery, upsertSuccess };
}

describe('Bitrix24SyncConsumer — client merge events', () => {
  it('comments the timeline of the merged client contact, changes no field, writes no mapping', async () => {
    const h = harness();
    const intents = await h.consumer.sync(mergeEvent());

    expect(h.listTimelineComments).toHaveBeenCalledWith('contact', '55', new Date('2026-10-22T09:59:00.000Z'));
    expect(h.added).toHaveLength(1);
    expect(h.added[0]).toMatchObject({ entity: 'contact', id: '55' });
    expect(h.added[0].comment).toContain('ERP №9');
    // The day of the merge (Asia/Almaty), so a late delivery reads as history.
    expect(h.added[0].comment).toContain('ERP, 22.10.2026:');
    expect(h.added[0].comment).toContain('Метка: ERP-MERGE-12');
    // ERP data in the text goes through the safe-text filter: no link reaches Bitrix.
    expect(h.added[0].comment).not.toContain('evil.example');
    expect(h.bitrix.updateCrmItem).not.toHaveBeenCalled();
    expect(intents).toHaveLength(1);
    expect(intents[0].mapping).toBeUndefined();
    expect(intents[0].audit).toMatchObject({
      event: 'crm_sync.client_merge_comment',
      entityType: 'client',
      entityId: '7',
      relatedClientId: 7,
      relatedEntities: [{ entityType: 'client', entityId: 9 }, { entityType: 'client_merge', entityId: 12 }],
      metadata: { mergeId: 12, survivorId: 9, kind: 'merged', outcome: 'commented', commentId: '901', bitrixObject: 'contact', bitrixId: '55' },
    });
  });

  it('a retry finds its own comment by the marker and does not add a second one', async () => {
    const h = harness({ comments: [{ id: '880', comment: 'ERP: ... Метка: ERP-MERGE-12' }] });
    const intents = await h.consumer.sync(mergeEvent());
    expect(h.addTimelineComment).not.toHaveBeenCalled();
    expect(intents[0].audit.metadata).toMatchObject({ outcome: 'commented', commentId: '880', recovered: true });
  });

  it('the marker of another merge or of the undo is not taken for this one', async () => {
    const h = harness({ comments: [
      { id: '1', comment: 'Метка: ERP-MERGE-123' },
      { id: '2', comment: 'Метка: ERP-MERGE-UNDO-12' },
    ] });
    await h.consumer.sync(mergeEvent());
    expect(h.added).toHaveLength(1);
  });

  it('the undo gets its own comment and marker', async () => {
    const h = harness({ comments: [{ id: '880', comment: 'Метка: ERP-MERGE-12' }] });
    const intents = await h.consumer.sync(mergeEvent('merge_undone'));
    expect(h.added[0].comment).toContain('отменено');
    expect(h.added[0].comment).toContain('Метка: ERP-MERGE-UNDO-12');
    expect(intents[0].audit.metadata).toMatchObject({ kind: 'merge_undone', outcome: 'commented' });
  });

  it('an incomplete read of the timeline fails the event (retried) instead of risking a duplicate', async () => {
    const h = harness({ complete: false });
    await expect(h.consumer.sync(mergeEvent())).rejects.toThrow(/could not be read in full/);
    expect(h.addTimelineComment).not.toHaveBeenCalled();
  });

  it('a lost answer of the create propagates as an audit-only failure (the retry recovers by the marker)', async () => {
    const h = harness({ addError: new Bitrix24ApiError('crm.timeline.comment.add', 'NETWORK_ERROR', 0, 'socket hang up') });
    const error = await h.consumer.sync(mergeEvent()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CrmSyncAuditOnlyError);
    expect((error as Error).message).toMatch(/NETWORK_ERROR/);
    expect((error as CrmSyncAuditOnlyError).target).toMatchObject({ erpId: '7', metadata: { mergeId: 12, survivorId: 9 } });
  });

  it('a contact deleted in Bitrix is recorded, not retried', async () => {
    const h = harness({ addError: new Bitrix24ApiError('crm.timeline.comment.add', 'NOT_FOUND', 400, 'Not found') });
    const intents = await h.consumer.sync(mergeEvent());
    expect(intents[0].audit.metadata).toMatchObject({ outcome: 'counterparty_missing' });
  });

  it('no active counterparty or no comment capability (dry-run): audit only, nothing sent', async () => {
    const deleted = harness({ mapping: { ...contact, status: 'deleted' } });
    expect((await deleted.consumer.sync(mergeEvent()))[0].audit.metadata).toMatchObject({ outcome: 'no_counterparty' });
    expect(deleted.listTimelineComments).not.toHaveBeenCalled();
    const none = harness({ mapping: null });
    expect((await none.consumer.sync(mergeEvent()))[0].audit.metadata).toMatchObject({ outcome: 'no_counterparty' });
    const dryRun = harness({ noComments: true });
    expect((await dryRun.consumer.sync(mergeEvent()))[0].audit.metadata).toMatchObject({ outcome: 'comments_unavailable' });
  });

  it('a malformed payload fails closed', async () => {
    for (const payload of [
      {},
      { mergeId: 12, mergedClientId: 7, survivorId: 7 },
      { mergeId: '12', mergedClientId: 'x', survivorId: 9 },
      { mergeId: 0, mergedClientId: 7, survivorId: 9 },
    ]) {
      const h = harness();
      await expect(h.consumer.sync(mergeEvent('merged', payload))).rejects.toThrow(/invalid client merge payload/);
      expect(h.addTimelineComment).not.toHaveBeenCalled();
    }
  });

  it('an event without its creation time fails instead of guessing the search window', async () => {
    const h = harness();
    await expect(h.consumer.sync({ ...mergeEvent(), createdAt: undefined })).rejects.toThrow(/no creation time/);
    expect(h.listTimelineComments).not.toHaveBeenCalled();
  });

  it('a merge comment that arrives after the undo is suppressed (audited as superseded)', async () => {
    const h = harness({ mergeStatus: 'undone' });
    const intents = await h.consumer.sync(mergeEvent());
    expect(h.addTimelineComment).not.toHaveBeenCalled();
    expect(intents[0].audit.metadata).toMatchObject({ outcome: 'superseded', kind: 'merged' });
    // The undo comment itself is still delivered.
    const undo = harness({ mergeStatus: 'undone' });
    await undo.consumer.sync(mergeEvent('merge_undone'));
    expect(undo.added).toHaveLength(1);
  });
});

describe('Bitrix24SyncConsumer — upsert of a merged client', () => {
  const clientEvent: OutboxEventRecord = {
    outboxEventId: 'event-client', eventType: 'crm.sync.client.upsert', aggregateType: 'crm_sync', aggregateId: '7',
    payload: { entity: 'client', id: '7', op: 'upsert' }, attempts: 0,
  };
  const merged = { client: { clientId: '7', personType: 'individual', isActive: false, mergedIntoClientId: '9' } };

  it('updates the alias contact in place and keeps the mapping on it', async () => {
    const h = harness(merged);
    const intents = await h.consumer.sync(clientEvent);
    expect(h.bitrix.updateCrmItem).toHaveBeenCalledWith(3, '55', expect.any(Object));
    expect(h.bitrix.createCrmItem).not.toHaveBeenCalled();
    expect(intents[0].mapping).toMatchObject({ erpId: '7', bitrixObject: 'contact', bitrixId: '55', status: 'active' });
  });

  it('an alias deleted in Bitrix is not recreated', async () => {
    const h = harness({ ...merged, updateError: new Bitrix24ApiError('crm.item.update', 'NOT_FOUND', 400, 'Not found') });
    const intents = await h.consumer.sync(clientEvent);
    expect(h.bitrix.createCrmItem).not.toHaveBeenCalled();
    expect(h.bitrix.findCrmItemByOrigin).not.toHaveBeenCalled();
    expect(intents[0].mapping).toBeUndefined();
    expect(intents[0].audit).toMatchObject({
      event: 'crm_sync.merged_client_skipped',
      relatedClientId: 7,
      metadata: { survivorId: 9, reason: 'alias_missing', bitrixId: '55' },
    });
  });

  it('no active alias of the same kind: nothing is created, replaced or deleted', async () => {
    for (const mapping of [null, { ...contact, status: 'deleted' }, { ...contact, bitrixObject: 'company' }]) {
      const h = harness({ ...merged, mapping });
      const intents = await h.consumer.sync(clientEvent);
      expect(h.bitrix.createCrmItem).not.toHaveBeenCalled();
      expect(h.bitrix.updateCrmItem).not.toHaveBeenCalled();
      expect(h.bitrix.deleteCrmItem).not.toHaveBeenCalled();
      expect(intents[0].audit.metadata).toMatchObject({ reason: 'no_alias' });
    }
  });

  it('a transient failure of the alias update never marks the alias mapping failed', async () => {
    const h = harness({ ...merged, updateError: new Bitrix24ApiError('crm.item.update', 'INTERNAL', 503, 'busy') });
    const error = await h.consumer.sync(clientEvent).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CrmSyncAuditOnlyError);
    expect((error as CrmSyncAuditOnlyError).target).toMatchObject({ erpId: '7', metadata: { survivorId: 9, bitrixId: '55' } });
    expect(h.bitrix.createCrmItem).not.toHaveBeenCalled();
  });

  it('an alias left failed by an earlier attempt is updated and becomes active again', async () => {
    const h = harness({ ...merged, mapping: { ...contact, status: 'failed' } });
    const intents = await h.consumer.sync(clientEvent);
    expect(h.bitrix.updateCrmItem).toHaveBeenCalledWith(3, '55', expect.any(Object));
    expect(intents[0].mapping).toMatchObject({ bitrixId: '55', status: 'active' });
  });

  it('a merge that commits while the contact is being written: the create path re-reads under the merge key and only updates the alias', async () => {
    const h = harness({
      clients: [
        { clientId: '7', personType: 'individual', isActive: true, mergedIntoClientId: null },
        { clientId: '7', personType: 'individual', isActive: false, mergedIntoClientId: '9' },
      ],
      updateError: new Bitrix24ApiError('crm.item.update', 'NOT_FOUND', 400, 'Not found'),
    });
    const intents = await h.consumer.sync(clientEvent);
    expect(h.lockQuery).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
      ['bitrix24-reverse:client:erp:7'],
    );
    expect(h.bitrix.findCrmItemByOrigin).not.toHaveBeenCalled();
    expect(h.bitrix.createCrmItem).not.toHaveBeenCalled();
    expect(intents[0].mapping).toBeUndefined();
    expect(intents[0].audit.metadata).toMatchObject({ reason: 'alias_missing', survivorId: 9 });
  });

  it('a client that is not merged still finds or creates its contact, under the merge key', async () => {
    const h = harness({
      client: { clientId: '7', personType: 'individual', mergedIntoClientId: null },
      updateError: new Bitrix24ApiError('crm.item.update', 'NOT_FOUND', 400, 'Not found'),
    });
    const intents = await h.consumer.sync(clientEvent);
    expect(h.lockQuery).toHaveBeenCalledTimes(1);
    expect(h.bitrix.createCrmItem).toHaveBeenCalledTimes(1);
    // Nothing is written before the relay persists the intent (dry-run and ownership fencing stay with the relay).
    expect(h.upsertSuccess).not.toHaveBeenCalled();
    expect(intents[0].mapping).toMatchObject({ bitrixId: '777', status: 'active' });
  });
});
