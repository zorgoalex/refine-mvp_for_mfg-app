import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgCncTelegramImportRepository } from './pg-cnc-telegram-import-repository';

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const actor = { id: '1', username: 'e2e_test', role: 'manager', roleId: 1, permissions: [] };
const prepareInput = { currentUser: actor, scanId: 'scan-1', candidateIds: [first, second], requestId: 'request-1', idempotencyKey: 'key-1' };

function harness(replaceableDraft = false) {
  let request: Record<string, unknown> | null = null;
  const items: Array<Record<string, unknown>> = [];
  const candidates = [first, second].map((id) => ({
    candidate_id: id, scan_id: 'scan-1', eligibility_status: 'valid',
    expires_at: new Date(Date.now() + 60000).toISOString(), duplicate_match_version: 1,
  }));
  const tx = { query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    if (sql === 'SELECT * FROM cnc_telegram_import_requests WHERE import_request_id=$1 AND requested_by=$2 FOR UPDATE') {
      return { rows: replaceableDraft ? [{
        import_request_id: 'old-draft', requested_by: '1', scan_id: 'scan-1', status: 'draft',
        confirmation_id: 'old-confirm', confirmed_at: null, repeat_of_import_request_id: null,
      }] : [], rowCount: replaceableDraft ? 1 : 0 };
    }
    if (sql.includes('FROM cnc_telegram_import_scans')) return { rows: [{ scan_id: 'scan-1', status: 'ready' }], rowCount: 1 };
    if (sql.includes('FROM cnc_telegram_import_candidates WHERE scan_id')) return { rows: candidates, rowCount: 2 };
    if (sql.startsWith('SELECT') && sql.includes('FROM cnc_telegram_import_candidates WHERE candidate_id')) return { rows: candidates.filter((row) => row.candidate_id === params[0]), rowCount: 1 };
    if (sql.includes('FROM cnc_telegram_import_requests WHERE requested_by')) return { rows: request ? [request] : [], rowCount: request ? 1 : 0 };
    if (sql.includes('FROM cnc_telegram_import_requests') && sql.includes('FOR SHARE')) return { rows: [{ ...request, import_request_id: 'original', scan_id: 'scan-1', status: 'failed' }], rowCount: 1 };
    if (sql.includes('INSERT INTO cnc_telegram_import_requests')) {
      request = { import_request_id: 'request-1', scan_id: 'scan-1', requested_by: '1',
        request_hash: params[4], selection_hash: params[5], status: 'draft', confirmation_id: 'confirm-1', selected_count: 2 };
      return { rows: [request], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO cnc_telegram_import_items')) {
      items.push({ import_item_id: `item-${items.length}`, candidate_id: params[1], requested_cut_job_id: params[5], status: 'pending' });
    }
    if (sql.includes('FROM cnc_telegram_import_items WHERE import_request_id')) return { rows: items, rowCount: items.length };
    if (sql.includes('INSERT INTO audit_log')) return { rows: [{ audit_id: 'audit-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }) };
  const db = { transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx) } as unknown as DatabaseService;
  return { repository: new PgCncTelegramImportRepository(db, {} as never), tx, items };
}

describe('durable Telegram import number assignments', () => {
  it('replaces a stale preparation with audited identity and replays without replacing it twice', async () => {
    const { repository, tx } = harness(true);
    const replaceDraft = { importRequestId: 'old-draft', confirmationId: 'old-confirm' };
    const input = { ...prepareInput, requestedCutJobIds: { [first]: 55 }, replaceDraft };
    await repository.prepare(input);
    const replacements = () => tx.query.mock.calls.filter(([sql]) => sql.includes("UPDATE cnc_telegram_import_requests SET status='failed'"));
    expect(replacements()).toHaveLength(1);
    const auditCalls = tx.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO audit_log'));
    expect(JSON.stringify(auditCalls)).toContain('cnc.telegram_import.draft_replaced');
    expect(tx.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO outbox_events'))).toBe(true);
    await repository.prepare(input);
    expect(replacements()).toHaveLength(1);
    await expect(repository.prepare({ ...input, replaceDraft: { ...replaceDraft, confirmationId: 'different' } })).rejects.toMatchObject({ statusCode: 409 });
    expect(replacements()).toHaveLength(1);
  });
  it('persists per-item choices, returns them, and hashes normalized choices for replay', async () => {
    const { repository, tx } = harness();
    const result = await repository.prepare({ ...prepareInput, requestedCutJobIds: { [second]: 12, [first]: 42 } });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: first, requestedCutJobId: 42 }),
      expect.objectContaining({ candidateId: second, requestedCutJobId: 12 }),
    ]));
    await expect(repository.prepare({ ...prepareInput, requestedCutJobIds: { [first]: 42, [second]: 12 } })).resolves.toMatchObject({ importRequestId: 'request-1' });
    expect(tx.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO cnc_telegram_import_requests'))).toHaveLength(1);
    await expect(repository.prepare({ ...prepareInput, requestedCutJobIds: { [first]: 43, [second]: 12 } })).rejects.toMatchObject({ statusCode: 409 });
    await expect(repository.prepare(prepareInput)).rejects.toMatchObject({ statusCode: 409 });
    const audit = tx.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO audit_log'));
    expect(JSON.stringify(audit?.[1])).toContain('requestedCutJobIds');
  });

  it('keeps the terminal-selection fence independent of chosen numbers', async () => {
    const a = harness(); const b = harness();
    await a.repository.prepare({ ...prepareInput, requestedCutJobIds: { [first]: 42 } });
    await b.repository.prepare({ ...prepareInput, requestedCutJobIds: { [first]: 43 } });
    const insert = (h: ReturnType<typeof harness>) => h.tx.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO cnc_telegram_import_requests'))![1];
    expect(insert(a)?.[5]).toBe(insert(b)?.[5]);
    expect(insert(a)?.[4]).not.toBe(insert(b)?.[4]);
  });

  it('repeat preparation accepts a corrected number and leaves omitted numbers automatic', async () => {
    const { repository } = harness();
    const result = await repository.repeatPrepare({ currentUser: actor, importRequestId: 'original', candidateIds: [first, second],
      requestedCutJobIds: { [first]: 55 }, idempotencyKey: 'repeat-1', requestId: 'repeat-1' });
    expect(result.items.map((item) => item.requestedCutJobId)).toEqual([55, null]);
  });

  it.each([{ [first]: 42, [second]: 42 }, { unselected: 44 }, { [first]: 1.5 }])('rejects invalid assignments before any write', async (requestedCutJobIds) => {
    const { repository, tx } = harness();
    await expect(repository.prepare({ ...prepareInput, requestedCutJobIds })).rejects.toMatchObject({ statusCode: 422 });
    expect(tx.query).not.toHaveBeenCalled();
  });
});
