import { Pool, type QueryResultRow } from 'pg';
import type { TransactionClient } from '../src/database/database.types';
import { projectTelegramLabelMap } from '../src/modules/cnc-telegram/adapters/cnc-telegram-label-map-projector';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const actorUserId = readArg('--actor-user-id');
const requestIdPrefix = readArg('--request-id-prefix');
if (apply && (!actorUserId || !/^\d+$/.test(actorUserId) || !requestIdPrefix)) {
  throw new Error('--apply requires --actor-user-id <id> and --request-id-prefix <value>');
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

async function main(): Promise<void> {
  const actor = apply
    ? await pool.query<{ username: string | null; role_code: string | null }>(
      `SELECT u.username, r.role_code FROM users u LEFT JOIN roles r ON r.role_id=u.role_id WHERE u.user_id=$1`,
      [Number(actorUserId)],
    )
    : null;
  if (apply && !actor?.rows[0]) throw new Error('actor user not found');
  const candidates = await pool.query<{ packet_id: string }>(
    `SELECT packet.packet_id
     FROM cnc_telegram_packets packet
     WHERE packet.cut_layout_json->>'status'='valid'
     ORDER BY packet.packet_id`,
  );
  const counters: Record<string, number> = {
    candidates: candidates.rows.length,
    projected: 0,
    already_projected: 0,
    missing_evidence: 0,
    skipped: 0,
    failures: 0,
  };
  for (const [index, candidate] of candidates.rows.entries()) {
    if (!apply) {
      const state = await pool.query<{ has_evidence: boolean; has_map: boolean }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM cnc_telegram_packet_evidence_set evidence
             JOIN cnc_telegram_packets packet ON packet.packet_id=evidence.packet_id
             WHERE evidence.packet_id=$1::uuid AND evidence.source_version=packet.source_version
               AND evidence.payload_hash=packet.payload_hash
           ) AS has_evidence,
           EXISTS (
             SELECT 1 FROM cnc_telegram_label_sheet_map map
             JOIN cnc_telegram_packets packet ON packet.packet_id=map.packet_id
             WHERE map.packet_id=$1::uuid AND map.source_version=packet.source_version
           ) AS has_map`,
        [candidate.packet_id],
      );
      if (state.rows[0]?.has_map) counters.already_projected += 1;
      else if (!state.rows[0]?.has_evidence) counters.missing_evidence += 1;
      else counters.skipped += 1;
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_session_user($1)', [actorUserId]);
      const tx: TransactionClient = {
        raw: client as never,
        query<T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) {
          return client.query<T>(text, [...params]);
        },
      };
      const result = await projectTelegramLabelMap(tx, {
        packetId: candidate.packet_id,
        source: 'backfill',
        context: {
          actorUserId: Number(actorUserId),
          actorUsername: actor!.rows[0].username,
          actorRole: actor!.rows[0].role_code,
          requestId: `${requestIdPrefix}:${index + 1}`,
        },
      });
      await client.query('COMMIT');
      if (result.projected) counters.projected += 1;
      else if (result.reason === 'already_projected') counters.already_projected += 1;
      else if (result.reason === 'missing_evidence') counters.missing_evidence += 1;
      else counters.skipped += 1;
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      counters.failures += 1;
    } finally {
      client.release();
    }
  }
  process.stdout.write(`${JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...counters })}\n`);
  if (counters.failures > 0) process.exitCode = 1;
}

function readArg(name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

void main().finally(() => pool.end());
