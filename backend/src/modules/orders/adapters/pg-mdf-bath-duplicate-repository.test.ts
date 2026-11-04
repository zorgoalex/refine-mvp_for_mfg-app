import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import { pairDigest, type MdfBathSideFacts } from '../domain/mdf-bath-duplicates';
import type { ResolveMdfBathDuplicateCommand } from '../application/mdf-bath-duplicate.types';
import { PgMdfBathDuplicateRepository } from './pg-mdf-bath-duplicate-repository';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Old bath 854 (job 10) and the re-cut 868 (job 11) of order 2979, the same two details. */
const HEADERS = [
  { result_id: '854', job_id: '10', result_no: 1, revision_no: 1, version: 3, job_name: 'Старая', source_display_number: null },
  { result_id: '868', job_id: '11', result_no: 1, revision_no: 1, version: 2, job_name: 'Новая', source_display_number: null },
];
const PLACEMENTS = ['854', '868'].flatMap(result_id => [
  { result_id, order_id: '2979', detail_id: '1', quantity: 2 },
  { result_id, order_id: '2979', detail_id: '2', quantity: 1 },
]);
const DETAILS = [
  { detail_id: '1', detail_number: 1, laminated_or_later: false, production_round: 1 },
  { detail_id: '2', detail_number: 2, laminated_or_later: false, production_round: 1 },
];
const COMPOSITION = ['10', '11'].flatMap(job_id => [
  { job_id, order_id: '2979', detail_id: '1', hdf_detail_id: null, quantity: 2 },
  { job_id, order_id: '2979', detail_id: '2', hdf_detail_id: null, quantity: 1 },
]);

function side(cutResultId: number, cutJobId: number, jobVersion: number): MdfBathSideFacts {
  return { bathCardId: `cut-result:${cutResultId}`, cutResultId, cutJobId, resultNo: 1, revisionNo: 1, jobVersion,
    jobName: '', sourceDisplayNumber: null,
    placements: [
      { orderId: 2979, detailId: 1, detailNumber: 1, quantity: 2, laminatedOrLater: false, productionRound: 1 },
      { orderId: 2979, detailId: 2, detailNumber: 2, quantity: 1, laminatedOrLater: false, productionRound: 1 },
    ],
    composition: [
      { orderId: 2979, detailId: 1, hdfDetailId: null, quantity: 2 },
      { orderId: 2979, detailId: 2, hdfDetailId: null, quantity: 1 },
    ],
    manualColumn: null, otherLinkedCards: 0 };
}
const DIGEST = pairDigest(side(854, 10, 3), side(868, 11, 2));

interface Scenario {
  existing?: QueryResultRow;
  visible?: number[];
  active?: string[];
  uniqueViolation?: boolean;
  /** Extra owner (HDF placement) of the old bath. */
  hdfOwner?: number;
}

function fakeTx(scenario: Scenario = {}) {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const tx: TransactionClient & { calls: typeof calls } = {
    raw: {} as TransactionClient['raw'],
    calls,
    async query<T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) {
      calls.push({ text, params });
      const answer = (input: QueryResultRow[] = []) => rows(input) as QueryResult<T>;
      if (text.includes('WHERE command_key = $1')) return answer(scenario.existing ? [scenario.existing] : []);
      if (text.includes('SELECT DISTINCT placed.cut_job_id')) return answer([{ id: '10' }, { id: '11' }]);
      if (text.includes('information_schema.columns')) return answer([{ present: true }]);
      if (text.includes('FROM order_details od')) return answer(DETAILS);
      if (text.includes('mdf_engine_state')) return answer([{ owns: true }]);
      if (text.includes('to_regclass(\'mdf_bath_duplicate_resolutions\')')) return answer([{ present: false }]);
      if (text.includes('SELECT DISTINCT ON (r.cut_job_id)')) {
        return answer((scenario.active ?? ['854', '868']).map(id => ({ id })));
      }
      if (text.includes('AS job_name')) return answer(HEADERS);
      if (text.includes('SELECT DISTINCT p.cut_result_id::text AS result_id')) {
        return answer([...PLACEMENTS.map(p => ({ result_id: p.result_id, order_id: p.order_id })),
          ...(scenario.hdfOwner ? [{ result_id: '854', order_id: String(scenario.hdfOwner) }] : [])]);
      }
      if (text.includes('FROM cut_result_placement p')) return answer(PLACEMENTS);
      if (text.includes('FROM cut_job_item i')) return answer(COMPOSITION);
      if (text.includes('FROM orders o')) return answer((scenario.visible ?? [2979]).map(id => ({ order_id: String(id) })));
      if (text.includes('INSERT INTO mdf_bath_duplicate_resolutions')) {
        if (scenario.uniqueViolation) throw Object.assign(new Error('duplicate key'), {
          code: '23505', constraint: 'uq_mdf_bath_duplicate_resolutions_command_key' });
        return answer([{ resolution_id: '15', action: params[3], bath_a: params[0], bath_b: params[1],
          target_bath: params[2], digest: params[4], shared_json: JSON.parse(String(params[5])), order_ids: params[6],
          created_at: '2026-10-30T10:00:00.000Z', request_digest: params[10], audit_id: null }]);
      }
      if (text.includes('INSERT INTO audit_log (')) return answer([{ audit_id: '501' }]);
      return answer();
    },
  };
  return tx;
}

function repository(tx: TransactionClient) {
  return new PgMdfBathDuplicateRepository({
    transaction: (handler: (client: TransactionClient) => Promise<unknown>) => handler(tx),
    query: tx.query.bind(tx),
  } as unknown as ConstructorParameters<typeof PgMdfBathDuplicateRepository>[0]);
}

function command(patch: Partial<ResolveMdfBathDuplicateCommand> = {}): ResolveMdfBathDuplicateCommand {
  return {
    currentUser: { id: '7', username: 'cutter', role: 'admin', roleId: 1,
      permissions: ['cut.manage', 'orders.view'] } as unknown as ResolveMdfBathDuplicateCommand['currentUser'],
    bathCardId: 'cut-result:868', otherBathCardId: 'cut-result:854', action: 'keep_both', expectedDigest: DIGEST,
    idempotencyKey: 'key-12345678', requestId: 'req-1', ...patch,
  };
}

function requestDigestOf(c: ResolveMdfBathDuplicateCommand) {
  return sha256(JSON.stringify([c.bathCardId, c.otherBathCardId, c.action, c.expectedDigest]));
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try { await promise; } catch (error) { return error as ApiError; }
  throw new Error('expected a rejection');
}

describe('PgMdfBathDuplicateRepository.resolve', () => {
  it('records the decision, its audit and one outbox event atomically under the bath barrier only', async () => {
    const tx = fakeTx();
    const result = await repository(tx).resolve(command());
    expect(result).toMatchObject({ replayed: false, auditId: '501', resolution: { resolutionId: 15, action: 'keep_both',
      bathA: 'cut-result:854', bathB: 'cut-result:868', targetBath: 'cut-result:868', otherBathCardId: 'cut-result:854',
      sharedCount: 2, orderIds: [2979] } });
    const texts = tx.calls.map(c => c.text);
    expect(texts[0]).toBe('SET LOCAL jit=off');
    const locks = tx.calls.filter(c => c.text.includes('pg_advisory_xact_lock'));
    expect(locks.map(c => c.params[0])).toEqual(['854', '868']);
    expect(locks[0].text).toContain("hashtext('mdf-bath:' || $1::text)");
    // r6/r7: no row locks on cut jobs or orders.
    expect(texts.some(text => /FOR (UPDATE|SHARE|KEY SHARE|NO KEY UPDATE)/.test(text))).toBe(false);
    const insert = tx.calls.find(c => c.text.includes('INSERT INTO mdf_bath_duplicate_resolutions'))!;
    expect(insert.params.slice(0, 5)).toEqual(['cut-result:854', 'cut-result:868', 'cut-result:868', 'keep_both', DIGEST]);
    expect(insert.params[9]).toBe('7:key-12345678');
    const audit = tx.calls.find(c => c.text.includes('INSERT INTO audit_log ('))!;
    expect(audit.params.slice(0, 3)).toEqual(['mdf_board.bath_duplicate_resolved', 'mdf_bath_duplicate', '15']);
    expect(audit.params[7]).toBe('backend-mdf-board');
    const related = tx.calls.filter(c => c.text.includes('INSERT INTO audit_log_related_entity')).map(c => c.params.slice(1));
    expect(related).toEqual(expect.arrayContaining([['order', 2979], ['order_detail', 1], ['order_detail', 2],
      ['cut_result', 854], ['cut_result', 868], ['cut_job', 10], ['cut_job', 11]]));
    expect(JSON.stringify(audit.params)).not.toMatch(/client/i);
    const outbox = tx.calls.filter(c => c.text.includes('INSERT INTO outbox_events'));
    expect(outbox).toHaveLength(1);
    expect(outbox[0].text).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(outbox[0].params[0]).toBe('mdf_board.bath_duplicate_resolved');
    expect(outbox[0].params[3]).toBe(`mdf-bath-duplicate:${sha256('7:key-12345678')}`);
  });

  it('marks the requested bath as the rework target', async () => {
    const tx = fakeTx();
    const result = await repository(tx).resolve(command({ action: 'rework_mark', bathCardId: 'cut-result:854',
      otherBathCardId: 'cut-result:868' }));
    expect(result.resolution).toMatchObject({ action: 'rework_mark', targetBath: 'cut-result:854',
      otherBathCardId: 'cut-result:868' });
  });

  it('refuses with 403 when an order of either bath is out of the user scope, before any staleness answer', async () => {
    const tx = fakeTx({ visible: [] });
    const error = await rejection(repository(tx).resolve(command({ expectedDigest: 'f'.repeat(64) })));
    expect(error).toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(tx.calls.some(c => c.text.includes('INSERT INTO'))).toBe(false);
  });

  it('authorizes by every owner of both baths: an invisible HDF-only owner gives 403', async () => {
    const tx = fakeTx({ hdfOwner: 4000, visible: [2979] });
    const error = await rejection(repository(tx).resolve(command()));
    expect(error).toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    const scope = tx.calls.find(c => c.text.includes('FROM orders o'))!;
    expect(scope.params[0]).toEqual([2979, 4000]);
    expect(tx.calls.some(c => c.text.includes('INSERT INTO'))).toBe(false);
  });

  it('refuses with 409 when the digest is stale or a bath is no longer active', async () => {
    const stale = await rejection(repository(fakeTx()).resolve(command({ expectedDigest: 'a'.repeat(64) })));
    expect(stale).toMatchObject({ statusCode: 409, code: 'MDF_BATH_DUPLICATE_STALE' });
    const archived = await rejection(repository(fakeTx({ active: ['868'] })).resolve(command()));
    expect(archived).toMatchObject({ statusCode: 409, code: 'MDF_BATH_DUPLICATE_STALE' });
  });

  it('replays the same key and body without new rows, and refuses the same key with another body', async () => {
    const original = command();
    const existing = { resolution_id: '15', action: 'keep_both', bath_a: 'cut-result:854', bath_b: 'cut-result:868',
      target_bath: 'cut-result:868', digest: DIGEST, shared_json: [{}, {}], order_ids: ['2979'],
      created_at: '2026-10-30T10:00:00.000Z', request_digest: requestDigestOf(original), audit_id: '501' };
    const tx = fakeTx({ existing });
    const replay = await repository(tx).resolve(original);
    expect(replay).toMatchObject({ replayed: true, auditId: '501', resolution: { resolutionId: 15, sharedCount: 2 } });
    expect(tx.calls.some(c => c.text.includes('INSERT INTO'))).toBe(false);

    const other = await rejection(repository(fakeTx({ existing })).resolve(command({ action: 'rework_mark' })));
    expect(other).toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });

    const foreign = await rejection(repository(fakeTx({ existing, visible: [] })).resolve(original));
    expect(foreign).toMatchObject({ statusCode: 403 });
  });

  it('maps a concurrent use of the same key to the idempotency conflict', async () => {
    const error = await rejection(repository(fakeTx({ uniqueViolation: true })).resolve(command()));
    expect(error).toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('refuses the same bath twice', async () => {
    const error = await rejection(repository(fakeTx()).resolve(command({ otherBathCardId: 'cut-result:868' })));
    expect(error).toMatchObject({ statusCode: 422 });
  });
});

describe('PgMdfBathDuplicateRepository.list (engine bath cards outside the board read)', () => {
  it('answers an active, fully visible bath with its pairs and omits one with an invisible order', async () => {
    const visible = await repository(fakeTx()).list({ currentUser: command().currentUser,
      bathCardIds: ['cut-result:868'] });
    expect(visible.baths).toHaveLength(1);
    expect(visible.baths[0]).toMatchObject({ bathCardId: 'cut-result:868', reworkDetailCount: 0,
      duplicates: [{ otherBathCardId: 'cut-result:854', digest: DIGEST, sharedCount: 2, blockedReason: 'engine' }] });
    const hidden = await repository(fakeTx({ visible: [] })).list({ currentUser: command().currentUser,
      bathCardIds: ['cut-result:868'] });
    expect(hidden.baths).toEqual([]);
    const hdfHidden = await repository(fakeTx({ hdfOwner: 4000, visible: [2979] })).list({
      currentUser: command().currentUser, bathCardIds: ['cut-result:854', 'cut-result:868'] });
    expect(hdfHidden.baths.map(b => b.bathCardId)).toEqual(['cut-result:868']);
    expect(hdfHidden.baths[0].duplicates[0]).toMatchObject({ otherJobLabel: null, blockedReason: 'scope' });
  });
});

function rows(input: QueryResultRow[] = []): QueryResult<QueryResultRow> {
  return { command: 'SELECT', rowCount: input.length, oid: 0, fields: [], rows: input };
}
