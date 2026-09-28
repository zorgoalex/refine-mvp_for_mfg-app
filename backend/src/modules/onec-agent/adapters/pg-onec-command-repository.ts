import { Inject, Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import type { DatabaseClient } from '../../../database/database.types';

/** SQL of the E2 command queue. Every agent-facing query is scoped by agent_id. */

export const ONEC_COMMANDS_CHANNEL = 'onec_agent_commands';

export interface CommandRow {
  commandId: string;
  agentId: string;
  sourceId: number;
  commandType: string;
  commandKind: 'admin' | 'business';
  payloadVersion: number;
  payloadCanonical: string | null;
  payloadHash: string;
  payloadBytes: number;
  priority: number;
  orderingKey: string | null;
  correlationId: string | null;
  notBeforeUtc: Date | null;
  expiresAtUtc: Date | null;
  requestedBy: { userId?: string; displayName?: string } | null;
  sourceModule: string;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  idempotencyKey: string;
  status: string;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  leaseCount: number;
  leasedAt: Date | null;
  receivedAt: Date | null;
  resultBody: string | null;
  resultSha256: string | null;
  resultErrorCode: string | null;
  resultReceivedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

export interface NewCommand {
  commandId: string;
  agentId: string;
  sourceId: number;
  commandType: string;
  commandKind: 'admin' | 'business';
  payloadVersion: number;
  payloadCanonical: string;
  payloadHash: string;
  payloadBytes: number;
  priority: number;
  orderingKey: string | null;
  correlationId: string | null;
  notBeforeUtc: string | null;
  expiresAtUtc: string | null;
  requestedBy: { userId?: string; displayName?: string } | null;
  sourceModule: string;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  idempotencyKey: string;
}

export function toCommand(row: QueryResultRow): CommandRow {
  return {
    commandId: row.command_id,
    agentId: row.agent_id,
    sourceId: Number(row.source_id),
    commandType: row.command_type,
    commandKind: row.command_kind,
    payloadVersion: Number(row.payload_version),
    payloadCanonical: row.payload_canonical,
    payloadHash: row.payload_hash,
    payloadBytes: Number(row.payload_bytes),
    priority: Number(row.priority),
    orderingKey: row.ordering_key,
    correlationId: row.correlation_id,
    notBeforeUtc: row.not_before_utc,
    expiresAtUtc: row.expires_at_utc,
    requestedBy: row.requested_by,
    sourceModule: row.source_module,
    sourceEntityType: row.source_entity_type,
    sourceEntityId: row.source_entity_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    leaseCount: Number(row.lease_count),
    leasedAt: row.leased_at,
    receivedAt: row.received_at,
    resultBody: row.result_body,
    resultSha256: row.result_sha256,
    resultErrorCode: row.result_error_code,
    resultReceivedAt: row.result_received_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
  };
}

@Injectable()
export class PgOnecCommandRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  get db(): DatabaseClient {
    return this.database;
  }

  transaction<T>(handler: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    return this.database.transaction(handler);
  }

  /** Inserts or returns the existing command of the same (source_module, idempotency_key). */
  async insert(tx: DatabaseClient, command: NewCommand): Promise<{ command: CommandRow; created: boolean }> {
    const { rows } = await tx.query(
      `INSERT INTO onec_agent_commands (command_id, agent_id, source_id, command_type, command_kind, payload_version,
         payload_canonical, payload_hash, payload_bytes, priority, ordering_key, correlation_id, not_before_utc,
         expires_at_utc, requested_by, source_module, source_entity_type, source_entity_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz,$15::jsonb,$16,$17,$18,$19)
       ON CONFLICT (source_module, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        command.commandId, command.agentId, command.sourceId, command.commandType, command.commandKind,
        command.payloadVersion, command.payloadCanonical, command.payloadHash, command.payloadBytes,
        command.priority, command.orderingKey, command.correlationId, command.notBeforeUtc, command.expiresAtUtc,
        command.requestedBy ? JSON.stringify(command.requestedBy) : null, command.sourceModule,
        command.sourceEntityType, command.sourceEntityId, command.idempotencyKey,
      ],
    );
    if (rows[0]) return { command: toCommand(rows[0]), created: true };
    const existing = await tx.query(
      `SELECT * FROM onec_agent_commands WHERE source_module = $1 AND idempotency_key = $2`,
      [command.sourceModule, command.idempotencyKey],
    );
    return { command: toCommand(existing.rows[0]!), created: false };
  }

  async findByIdempotencyKey(tx: DatabaseClient, sourceModule: string, idempotencyKey: string): Promise<CommandRow | null> {
    const { rows } = await tx.query(
      `SELECT * FROM onec_agent_commands WHERE source_module = $1 AND idempotency_key = $2`,
      [sourceModule, idempotencyKey],
    );
    return rows[0] ? toCommand(rows[0]) : null;
  }

  /** Delivered after commit: wakes long polls of this agent in every backend process. */
  async notify(tx: DatabaseClient, agentId: string): Promise<void> {
    await tx.query(`SELECT pg_notify($1, $2)`, [ONEC_COMMANDS_CHANNEL, agentId]);
  }

  async getSession(agentId: string, sessionId: string): Promise<{ accepted: boolean; lastSeenAt: Date } | null> {
    const { rows } = await this.database.query(
      `SELECT accepted, last_seen_at FROM onec_agent_sessions WHERE session_id = $1 AND agent_id = $2`,
      [sessionId, agentId],
    );
    return rows[0] ? { accepted: rows[0].accepted, lastSeenAt: rows[0].last_seen_at } : null;
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.database.query(`UPDATE onec_agent_sessions SET last_seen_at = now() WHERE session_id = $1`, [sessionId]);
  }

  /**
   * Leases the next issuable command (spec §4.2 / plan §6.2) in one statement:
   * queued, or leased with an expired lease (re-issue of the same command after
   * a lost lease/received response); supported type; not before notBefore and
   * not after expiresAt by ERP clock; no earlier queued/leased command with the
   * same ordering key; priority DESC, created_at, command_id.
   */
  async leaseNext(agentId: string, supportedTypes: readonly string[], leaseSeconds: number): Promise<CommandRow | null> {
    if (supportedTypes.length === 0) return null;
    const { rows } = await this.database.query(
      `WITH candidate AS (
         SELECT c.command_id
           FROM onec_agent_commands c
          WHERE c.agent_id = $1
            AND (c.status = 'queued' OR (c.status = 'leased' AND c.lease_expires_at < now()))
            AND c.command_type = ANY($2::text[])
            AND (c.not_before_utc IS NULL OR c.not_before_utc <= now())
            AND (c.expires_at_utc IS NULL OR c.expires_at_utc > now())
            AND (c.ordering_key IS NULL OR NOT EXISTS (
                  SELECT 1 FROM onec_agent_commands p
                   WHERE p.agent_id = c.agent_id AND p.ordering_key = c.ordering_key
                     AND p.status IN ('queued','leased')
                     AND (p.created_at, p.command_id) < (c.created_at, c.command_id)))
          ORDER BY c.priority DESC, c.created_at, c.command_id
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
       UPDATE onec_agent_commands t
          SET status = 'leased', lease_id = gen_random_uuid(),
              lease_expires_at = now() + ($3::int * interval '1 second'),
              lease_count = t.lease_count + 1, leased_at = now(), updated_at = now()
         FROM candidate
        WHERE t.command_id = candidate.command_id
       RETURNING t.*`,
      [agentId, supportedTypes, leaseSeconds],
    );
    return rows[0] ? toCommand(rows[0]) : null;
  }

  /** A superseded/aborted long poll gives back a lease it could not deliver (same bytes stay queued). */
  async returnLease(commandId: string, leaseId: string): Promise<void> {
    await this.database.query(
      `UPDATE onec_agent_commands SET status = 'queued', lease_id = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE command_id = $1 AND lease_id = $2 AND status = 'leased' AND received_at IS NULL`,
      [commandId, leaseId],
    );
  }

  async getForUpdate(tx: DatabaseClient, agentId: string, commandId: string): Promise<CommandRow | null> {
    const { rows } = await tx.query(
      `SELECT * FROM onec_agent_commands WHERE command_id = $1 AND agent_id = $2 FOR UPDATE`,
      [commandId, agentId],
    );
    return rows[0] ? toCommand(rows[0]) : null;
  }

  async markReceived(tx: DatabaseClient, commandId: string): Promise<void> {
    await tx.query(
      `UPDATE onec_agent_commands SET status = CASE WHEN status IN ('queued','leased') THEN 'received' ELSE status END,
              received_at = COALESCE(received_at, now()), lease_expires_at = NULL, updated_at = now()
        WHERE command_id = $1`,
      [commandId],
    );
  }

  async saveResult(
    tx: DatabaseClient,
    input: { commandId: string; status: string; body: string; sha256: string; errorCode: string | null },
  ): Promise<void> {
    await tx.query(
      `UPDATE onec_agent_commands
          SET status = CASE WHEN status IN ('cancelled','expired_undelivered') THEN status ELSE $2 END,
              received_at = COALESCE(received_at, now()), lease_expires_at = NULL,
              result_body = $3, result_sha256 = $4, result_error_code = $5, result_received_at = now(), updated_at = now()
        WHERE command_id = $1`,
      [input.commandId, input.status, input.body, input.sha256, input.errorCode],
    );
  }

  /** Cancel only before the agent could have it: queued, or leased with the lease expired and no receipt. */
  async cancel(tx: DatabaseClient, commandId: string, actorId: number): Promise<CommandRow | null> {
    const { rows } = await tx.query(
      `UPDATE onec_agent_commands SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
              lease_expires_at = NULL, updated_at = now()
        WHERE command_id = $1
          AND (status = 'queued' OR (status = 'leased' AND lease_expires_at < now()))
        RETURNING *`,
      [commandId, actorId],
    );
    return rows[0] ? toCommand(rows[0]) : null;
  }

  async getById(commandId: string, client: DatabaseClient = this.database): Promise<CommandRow | null> {
    const { rows } = await client.query(`SELECT * FROM onec_agent_commands WHERE command_id = $1`, [commandId]);
    return rows[0] ? toCommand(rows[0]) : null;
  }

  async list(filter: { agentId?: string; status?: string; commandType?: string; limit: number }): Promise<CommandRow[]> {
    const { rows } = await this.database.query(
      `SELECT * FROM onec_agent_commands
        WHERE ($1::text IS NULL OR agent_id = $1) AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR command_type = $3)
        ORDER BY created_at DESC, command_id DESC LIMIT $4`,
      [filter.agentId ?? null, filter.status ?? null, filter.commandType ?? null, filter.limit],
    );
    return rows.map(toCommand);
  }

  /** Commands whose expiresAt passed before any receipt: never delivered. */
  async expireUndelivered(tx: DatabaseClient): Promise<CommandRow[]> {
    const { rows } = await tx.query(
      `UPDATE onec_agent_commands SET status = 'expired_undelivered', lease_expires_at = NULL, updated_at = now()
        WHERE expires_at_utc IS NOT NULL AND expires_at_utc <= now()
          AND (status = 'queued' OR (status = 'leased' AND lease_expires_at < now()))
        RETURNING *`,
    );
    return rows.map(toCommand);
  }

  /** Retention: terminal commands older than 180 days keep metadata, lose payload/result bytes. */
  async purgeOldPayloads(): Promise<number> {
    const { rowCount } = await this.database.query(
      `UPDATE onec_agent_commands SET payload_canonical = NULL, result_body = NULL, payload_purged_at = now()
        WHERE payload_purged_at IS NULL AND updated_at < now() - interval '180 days'
          AND status IN ('succeeded','business_error','dead_letter','expired','cancelled','expired_undelivered')`,
    );
    return rowCount ?? 0;
  }
}
