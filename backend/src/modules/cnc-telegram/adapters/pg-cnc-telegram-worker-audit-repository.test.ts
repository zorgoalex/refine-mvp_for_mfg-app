import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { parseWorkerAuditBatch, type WorkerAuditBatchDto } from '../dto/cnc-telegram-worker-audit.dto';
import { PgCncTelegramWorkerAuditRepository } from './pg-cnc-telegram-worker-audit-repository';

const scanId = '550e8400-e29b-41d4-a716-446655440000';
const digest = 'a'.repeat(64);
const logKey = `tglog:raw-v1:${digest}`;

describe('PgCncTelegramWorkerAuditRepository immutable replay guards', () => {
  it('fails closed unless every required schema definition matches', async () => {
    const database = fakeDatabase((sql) => sql.includes('WITH expected_schema') ? [{ ready: true }] : defaultRows(sql));
    const repository = new PgCncTelegramWorkerAuditRepository(database.service);

    await expect(repository.capabilities()).resolves.toBe(true);
    const capabilitySql = database.sql.find((sql) => sql.includes('WITH expected_schema')) ?? '';
    for (const marker of [
      'cnc_telegram_worker_scans_writer_user_id_fkey',
      'chk_cnc_tg_worker_message_reason_codes',
      'cnc_telegram_worker_operations_scan_id_fkey',
      'chk_cnc_tg_worker_observation_owner',
      'chk_cnc_tg_worker_observation_classification_code',
      'idx_cnc_tg_worker_messages_search',
      'uq_cnc_tg_worker_observation_operation_ordinal',
    ]) expect(capabilitySql).toContain(marker);
    expect(capabilitySql).toContain('pg_get_constraintdef(oid)');
    expect(capabilitySql).toContain("indexname || '|' || indexdef");
    expect(capabilitySql).toContain("pg_get_functiondef(to_regprocedure('cnc_telegram_worker_reason_code_valid(text)'))");
  });

  it('rejects a conflicting message identity instead of attaching evidence to another log', async () => {
    const database = fakeDatabase((sql) => sql.includes('INSERT INTO cnc_telegram_worker_message_logs') ? [] : defaultRows(sql));
    const repository = new PgCncTelegramWorkerAuditRepository(database.service);

    await expect(repository.writeBatch(batch(), { id: '77' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'AUDIT_LOG_CONFLICT',
    });
    const messageSql = database.sql.find((sql) => sql.includes('INSERT INTO cnc_telegram_worker_message_logs')) ?? '';
    expect(messageSql).toContain('raw_source_digest=EXCLUDED.raw_source_digest');
    expect(messageSql).toContain('source_message_id=EXCLUDED.source_message_id');
  });

  it('preserves a terminal reason when a later scan observes the same message again', async () => {
    const database = fakeDatabase((sql) => defaultRows(sql));
    const repository = new PgCncTelegramWorkerAuditRepository(database.service);

    await repository.writeBatch(batch(), { id: '77' });

    const messageSql = database.sql.find((sql) => sql.includes('INSERT INTO cnc_telegram_worker_message_logs')) ?? '';
    expect(messageSql).toContain("WHEN EXCLUDED.status='observed' AND cnc_telegram_worker_message_logs.status<>'observed'");
    expect(messageSql).toContain('THEN cnc_telegram_worker_message_logs.reason_code');
    expect(messageSql).toContain('THEN cnc_telegram_worker_message_logs.reason_message');
  });

  it('rejects an operation-key replay with a different owner or terminal evidence', async () => {
    const database = fakeDatabase((sql) => sql.includes('INSERT INTO cnc_telegram_worker_operations') ? [] : defaultRows(sql));
    const repository = new PgCncTelegramWorkerAuditRepository(database.service);

    await expect(repository.writeBatch(batch({ operation: true }), { id: '77' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'AUDIT_OPERATION_CONFLICT',
    });
    const operationSql = database.sql.find((sql) => sql.includes('INSERT INTO cnc_telegram_worker_operations')) ?? '';
    expect(operationSql).toContain('scan_id=EXCLUDED.scan_id');
    expect(operationSql).toContain('log_id=EXCLUDED.log_id');
    expect(operationSql).toContain('reason_message IS NOT DISTINCT FROM EXCLUDED.reason_message');
    expect(operationSql).toContain('reconciliation_window_to IS NOT DISTINCT FROM EXCLUDED.reconciliation_window_to');
    expect(operationSql).toContain('EXCLUDED.steps_json @> cnc_telegram_worker_operations.steps_json');
    expect(operationSql).toContain('EXCLUDED.responses_json @> cnc_telegram_worker_operations.responses_json');
    expect(operationSql).toContain('reply_text IS NULL OR cnc_telegram_worker_operations.reply_text IS NOT DISTINCT FROM EXCLUDED.reply_text');
  });

  it('accepts only an exact observation replay after an ordinal conflict', async () => {
    const database = fakeDatabase((sql) => {
      if (sql.includes('INSERT INTO cnc_telegram_worker_message_observations')) return [];
      if (sql.includes('SELECT observation_id')) return [];
      return defaultRows(sql);
    });
    const repository = new PgCncTelegramWorkerAuditRepository(database.service);

    await expect(repository.writeBatch(batch({ observation: true }), { id: '77' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'AUDIT_OBSERVATION_CONFLICT',
    });
    const replaySql = database.sql.find((sql) => sql.includes('SELECT observation_id')) ?? '';
    expect(replaySql).toContain('log_id=$2::uuid');
    expect(replaySql).toContain('classification_code=$9');
    expect(replaySql).toContain('decision_code IS NOT DISTINCT FROM $10');
  });

  it('exports every stored evidence layer with bounded parameterized filters', async () => {
    const database = fakeDatabase(() => []);
    const repository = new PgCncTelegramWorkerAuditRepository(database.service);

    await expect(repository.exportDetailed({
      dateFrom: '2026-08-01',
      dateTo: '2026-08-06',
      status: 'failed',
      messageType: 'svg',
      reasonCode: 'backend_ingest_failed',
      search: 'layout.svg',
    })).resolves.toEqual({ scans: [], messages: [] });

    const messageIndex = database.sql.findIndex((sql) => sql.includes('FROM cnc_telegram_worker_message_logs m'));
    const messageSql = database.sql[messageIndex] ?? '';
    expect(messageSql).toContain('m.raw_source_digest AS "rawSourceDigest"');
    expect(messageSql).toContain('m.last_decision_at AS "lastDecisionAt"');
    expect(messageSql).toContain("'observationId', o.observation_id");
    expect(messageSql).toContain("'operationKey', op.operation_key");
    expect(messageSql).toContain("'steps', p.steps_json");
    expect(messageSql).toContain("'responses', p.responses_json");
    expect(messageSql).toContain('m.status = $3');
    expect(messageSql).toContain('m.message_type = $4');
    expect(messageSql).toContain('m.reason_code = $5');
    expect(messageSql).toContain("plainto_tsquery('simple', $6)");
    expect(messageSql).toContain('LIMIT $7');
    expect(database.params[messageIndex]?.at(-1)).toBe(50_001);

    const scanSql = database.sql.find((sql) => sql.includes('FROM cnc_telegram_worker_scans')) ?? '';
    expect(scanSql).toContain('writer_user_id::text AS "writerUserId"');
    expect(scanSql).toContain('created_at AS "createdAt"');
    expect(scanSql).toContain('LIMIT $3');
  });
});

function batch(options: { operation?: boolean; observation?: boolean } = {}): WorkerAuditBatchDto {
  return parseWorkerAuditBatch({
    scan: {
      scanId, sourceChatId: '-100123', workday: '2026-08-06', status: 'completed',
      startedAt: '2026-08-06T10:00:00+00:00', finishedAt: '2026-08-06T10:01:00+00:00',
      sessionUserId: '77', dayYieldedCount: 1, dayExhausted: true, dayTruncated: false,
      replySearchYieldedCount: 0, replySearchExhausted: true, replySearchTruncated: false,
      svgCount: 1, processedCount: 1, ingestedCount: 1, skippedCount: 0, failedCount: 0,
      parserVersion: 'v1', workerVersion: 'v1', canWriteChat: false,
    },
    messages: [{
      logKey, rawSourceDigest: `sha256:${digest}`, sanitizerVersion: 'v1', sourceChatId: '-100123',
      sourceMessageId: '10', sourceCreatedAt: '2026-08-06T10:00:00+00:00', workday: '2026-08-06',
      messageType: 'svg', filename: 'layout.svg', outgoing: false, status: 'ingested',
      reasonCode: 'backend_ingest_succeeded', observedAt: '2026-08-06T10:00:00+00:00',
    }],
    operations: options.operation ? [{
      operationKey: `tgop:v1:${scanId}:${digest}:message_processing:1`, scanId, logKey,
      operationType: 'message_processing', status: 'succeeded',
      plannedAt: '2026-08-06T10:00:00+00:00', finishedAt: '2026-08-06T10:01:00+00:00',
      reasonCode: 'backend_ingest_succeeded', reconciliationYieldedCount: 0,
      reconciliationExhausted: false, reconciliationTruncated: false, steps: [], responses: [],
    }] : [],
    observations: options.observation ? [{
      scanId, logKey, sourceChatId: '-100123', sourceMessageId: '10',
      observedAt: '2026-08-06T10:00:00+00:00', readSource: 'day_history', readOrdinal: 1,
      classificationCode: 'message_svg',
    }] : [],
  });
}

function defaultRows(sql: string): QueryResultRow[] {
  if (sql.includes('INSERT INTO cnc_telegram_worker_scans')) return [{ scan_id: scanId }];
  if (sql.includes('INSERT INTO cnc_telegram_worker_message_logs')) return [{ log_id: '11111111-1111-4111-8111-111111111111' }];
  if (sql.includes('INSERT INTO cnc_telegram_worker_operations')) return [{ operation_id: '22222222-2222-4222-8222-222222222222' }];
  if (sql.includes('INSERT INTO cnc_telegram_worker_message_observations')) return [{ observation_id: '33333333-3333-4333-8333-333333333333' }];
  return [];
}

function fakeDatabase(rowsFor: (sql: string) => QueryResultRow[]): {
  service: DatabaseService;
  sql: string[];
  params: (readonly unknown[] | undefined)[];
} {
  const sql: string[] = [];
  const params: (readonly unknown[] | undefined)[] = [];
  const query = async <T extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>> => {
    sql.push(text);
    params.push(values);
    const rows = rowsFor(text) as T[];
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
  };
  const transactionClient = { query } as unknown as TransactionClient;
  const service = {
    query,
    transaction: async <T>(handler: (client: TransactionClient) => Promise<T>): Promise<T> => handler(transactionClient),
  } as unknown as DatabaseService;
  return { service, sql, params };
}
