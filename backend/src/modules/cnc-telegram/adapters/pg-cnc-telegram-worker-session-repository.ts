import { randomUUID } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import { DatabaseService } from '../../../database/database.service';
import type {
  CncTelegramWorkerSessionLeaseContext,
  CncTelegramWorkerSessionHeartbeatDto,
  CncTelegramWorkerSessionLeaseDto,
  CncTelegramWorkerSessionLeaseRepositoryPort,
  CncTelegramWorkerSessionLeaseResponse,
} from '../application/cnc-telegram-worker-session.types';
import { assertCurrentWorkerSessionInTransaction } from './cnc-telegram-worker-session-fencing';

// Keep a bounded grace window over the worker's default 10-second heartbeat.
// This avoids an expiry race when a heartbeat lands on the same second while
// still fencing a dead worker quickly.
const LEASE_SECONDS = 90;

interface LeaseRow {
  source_chat_id: string;
  lease_token: string;
  lease_generation: string | number;
  worker_instance_id: string;
  worker_image_revision: string;
  stack_env: string | null;
  worker_role: 'disabled' | 'reader' | 'writer' | null;
  can_send_manual_svg_uploads: boolean | null;
  manual_svg_send_poll_interval_seconds: string | number | null;
  parser_version: string | null;
  claimed_at: string | Date;
  heartbeat_at: string | Date;
  expires_at: string | Date;
  lease_active?: boolean;
}

export class PgCncTelegramWorkerSessionRepository implements CncTelegramWorkerSessionLeaseRepositoryPort {
  constructor(private readonly database: DatabaseService) {}

  async claim(input: CncTelegramWorkerSessionLeaseDto): Promise<CncTelegramWorkerSessionLeaseResponse> {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [input.sourceChatId]);
      const current = await tx.query<LeaseRow>(`
        SELECT source_chat_id, lease_token, lease_generation, worker_instance_id,
               worker_image_revision, stack_env, worker_role, can_send_manual_svg_uploads,
               manual_svg_send_poll_interval_seconds, parser_version,
               claimed_at, heartbeat_at, expires_at,
               expires_at > now() AS lease_active
          FROM cnc_telegram_worker_session_leases
         WHERE source_chat_id=$1
         FOR UPDATE
      `, [input.sourceChatId]);
      const row = current.rows[0];
      if (row?.lease_active) {
        throw new ApiError(
          409,
          'CNC_TELEGRAM_SESSION_LEASE_BUSY',
          'Telegram worker session lease is owned by another live worker',
          busyLeaseDetails(row),
        );
      }

      const token = randomUUID() + randomUUID();
      const result = row
        ? await tx.query<LeaseRow>(`
            UPDATE cnc_telegram_worker_session_leases
               SET lease_token=$2,
                   lease_generation=lease_generation+1,
                   worker_instance_id=$3::uuid,
                   worker_image_revision=$4,
                   stack_env=$5,
                   worker_role=$6,
                   can_send_manual_svg_uploads=$7,
                   manual_svg_send_poll_interval_seconds=$8,
                   parser_version=$9,
                   claimed_at=now(), heartbeat_at=now(),
                   expires_at=now() + ($10::integer * interval '1 second'), updated_at=now()
             WHERE source_chat_id=$1
         RETURNING source_chat_id, lease_token, lease_generation, worker_instance_id,
                   worker_image_revision, stack_env, worker_role, can_send_manual_svg_uploads,
                   manual_svg_send_poll_interval_seconds, parser_version,
                   claimed_at, heartbeat_at, expires_at
          `, leaseParams(input, token))
        : await tx.query<LeaseRow>(`
            INSERT INTO cnc_telegram_worker_session_leases
              (source_chat_id, lease_token, lease_generation, worker_instance_id,
               worker_image_revision, stack_env, worker_role, can_send_manual_svg_uploads,
               manual_svg_send_poll_interval_seconds, parser_version,
               claimed_at, heartbeat_at, expires_at)
            VALUES ($1, $2, 1, $3::uuid, $4, $5, $6, $7, $8, $9, now(), now(),
                    now() + ($10::integer * interval '1 second'))
         RETURNING source_chat_id, lease_token, lease_generation, worker_instance_id,
                   worker_image_revision, stack_env, worker_role, can_send_manual_svg_uploads,
                   manual_svg_send_poll_interval_seconds, parser_version,
                   claimed_at, heartbeat_at, expires_at
          `, leaseParams(input, token));
      const claimed = result.rows[0];
      if (!claimed) throw new Error('Telegram worker session lease claim returned no row');
      return mapLease(claimed);
    });
  }

  async heartbeat(input: CncTelegramWorkerSessionHeartbeatDto & CncTelegramWorkerSessionLeaseContext): Promise<CncTelegramWorkerSessionLeaseResponse> {
    const result = await this.database.query<LeaseRow>(`
      UPDATE cnc_telegram_worker_session_leases
         SET heartbeat_at=now(), expires_at=now() + ($5::integer * interval '1 second'),
             updated_at=now()
       WHERE source_chat_id=$1 AND lease_token=$2 AND lease_generation=$3
           AND worker_instance_id=$4::uuid AND expires_at > now()
   RETURNING source_chat_id, lease_token, lease_generation, worker_instance_id,
             worker_image_revision, stack_env, worker_role, can_send_manual_svg_uploads,
             manual_svg_send_poll_interval_seconds, parser_version,
             claimed_at, heartbeat_at, expires_at
    `, [input.sourceChatId, input.leaseToken, input.leaseGeneration,
      input.workerInstanceId, LEASE_SECONDS]);
    const row = result.rows[0];
    if (!row) throw staleLeaseError();
    return mapLease(row);
  }

  async release(input: CncTelegramWorkerSessionHeartbeatDto & CncTelegramWorkerSessionLeaseContext): Promise<void> {
    const result = await this.database.query<Pick<LeaseRow, 'source_chat_id'>>(`
      UPDATE cnc_telegram_worker_session_leases
         SET expires_at=now(), updated_at=now()
       WHERE source_chat_id=$1 AND lease_token=$2 AND lease_generation=$3
         AND worker_instance_id=$4::uuid AND expires_at > now()
   RETURNING source_chat_id
    `, [input.sourceChatId, input.leaseToken, input.leaseGeneration, input.workerInstanceId]);
    if (!result.rows[0]) throw staleLeaseError();
  }

  async assertCurrent(input: CncTelegramWorkerSessionLeaseContext): Promise<void> {
    const result = await this.database.query<{ ok: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM cnc_telegram_worker_session_leases
         WHERE source_chat_id=$1 AND lease_token=$2 AND lease_generation=$3
           AND worker_instance_id=$4::uuid AND expires_at > now()
      ) AS ok
    `, [input.sourceChatId, input.leaseToken, input.leaseGeneration, input.workerInstanceId]);
    if (!result.rows[0]?.ok) throw staleLeaseError();
  }

  async assertCurrentInTransaction(tx: import('../../../database/database.types').TransactionClient, input: CncTelegramWorkerSessionLeaseContext): Promise<void> {
    await assertCurrentWorkerSessionInTransaction(tx, input);
  }
}

function mapLease(row: LeaseRow): CncTelegramWorkerSessionLeaseResponse {
  return {
    sourceChatId: row.source_chat_id,
    leaseToken: row.lease_token,
    leaseGeneration: Number(row.lease_generation),
    workerInstanceId: row.worker_instance_id,
    workerImageRevision: row.worker_image_revision,
    runtimeEvidence: row.stack_env && row.worker_role && row.can_send_manual_svg_uploads !== null
      && row.manual_svg_send_poll_interval_seconds !== null && row.parser_version
      ? {
          stackEnv: row.stack_env,
          workerRole: row.worker_role,
          canSendManualSvgUploads: row.can_send_manual_svg_uploads,
          manualSvgSendPollIntervalSeconds: Number(row.manual_svg_send_poll_interval_seconds),
          parserVersion: row.parser_version,
        }
      : null,
    claimedAt: new Date(row.claimed_at).toISOString(),
    heartbeatAt: new Date(row.heartbeat_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function leaseParams(input: CncTelegramWorkerSessionLeaseDto, token: string): unknown[] {
  const runtime = input.runtimeEvidence;
  return [
    input.sourceChatId,
    token,
    input.workerInstanceId,
    input.workerImageRevision,
    runtime?.stackEnv ?? null,
    runtime?.workerRole ?? null,
    runtime?.canSendManualSvgUploads ?? null,
    runtime?.manualSvgSendPollIntervalSeconds ?? null,
    runtime?.parserVersion ?? null,
    LEASE_SECONDS,
  ];
}

function busyLeaseDetails(row: LeaseRow): Record<string, unknown> {
  return {
    sourceChatId: row.source_chat_id,
    workerInstanceId: row.worker_instance_id,
    workerImageRevision: row.worker_image_revision,
    runtimeEvidence: mapLease(row).runtimeEvidence,
    claimedAt: new Date(row.claimed_at).toISOString(),
    heartbeatAt: new Date(row.heartbeat_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

function staleLeaseError(): ApiError {
  return new ApiError(409, 'CNC_TELEGRAM_SESSION_LEASE_STALE', 'Telegram worker session lease is stale or expired');
}
