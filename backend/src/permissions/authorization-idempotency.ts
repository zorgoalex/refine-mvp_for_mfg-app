import { createHash } from 'node:crypto';
import { ApiError } from '../common/errors/api-error';
import type { TransactionClient } from '../database/database.types';

/**
 * Idempotency of authorization commands (access groups plan R7 §4.2; roles matrix R5 §5.3) on command_idempotency_keys,
 * the pattern of the users commands: claimed under the permissions_state lock, so a repeat waits for the first attempt
 * and replays its stored answer before any version check (CAS).
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,200}$/;

export interface IdempotencyClaim {
  key: string;
  name: string;
  entityType: string;
  entityId: string;
  hash: string;
  actorUserId: number | null;
}

/** sha256 of the command name, its entity and the payload with sorted keys (key order is not part of the request). */
export function idempotencyRequestHash(name: string, entityId: string, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify({ name, entityId, payload: sortKeys(payload) })).digest('hex');
}

/** Inserts the key (null: go on) or answers from the earlier attempt: its stored response, or 409. */
export async function claimIdempotency<T>(tx: TransactionClient, spec: IdempotencyClaim): Promise<T | null> {
  const inserted = await tx.query(
    `INSERT INTO command_idempotency_keys (idempotency_key, command_name, actor_user_id, entity_type, entity_id, request_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'processing') ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key`,
    [spec.key, spec.name, spec.actorUserId, spec.entityType, spec.entityId, spec.hash],
  );
  if (inserted.rowCount === 1) return null;
  const existing = await tx.query<{ request_hash: string; response_json: T | null; status: string; actor_user_id: string | number | null }>(
    'SELECT request_hash, response_json, status, actor_user_id FROM command_idempotency_keys WHERE idempotency_key = $1 FOR UPDATE',
    [spec.key],
  );
  const row = existing.rows[0];
  const storedActor = row?.actor_user_id === null || row?.actor_user_id === undefined ? null : Number(row.actor_user_id);
  if (!row || row.request_hash !== spec.hash || storedActor !== spec.actorUserId) {
    throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was reused with a different request');
  }
  if (row.status === 'completed' && row.response_json) return row.response_json;
  throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'Idempotent command is still processing');
}

/** Stores the answer in the same transaction as the change. */
export async function completeIdempotency(tx: TransactionClient, key: string, response: unknown): Promise<void> {
  await tx.query(
    `UPDATE command_idempotency_keys SET status = 'completed', response_json = $2::jsonb, completed_at = now() WHERE idempotency_key = $1`,
    [key, JSON.stringify(response)],
  );
}

/** The Idempotency-Key header: one value matching IDEMPOTENCY_KEY_PATTERN; absent → undefined unless required. */
export function parseIdempotencyKey(header: string | string[] | undefined, required: boolean): string | undefined {
  if (header === undefined && !required) return undefined;
  const key = Array.isArray(header) ? (header.length === 1 ? header[0] : undefined) : header;
  if (key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new ApiError(422, 'VALIDATION_ERROR', `Idempotency-Key${required ? ' is required' : ''}: 8..200 characters [A-Za-z0-9_.:-]`, {
      errors: [{ field: 'Idempotency-Key', message: required ? 'required' : 'invalid' }],
    });
  }
  return key;
}

export function idempotencyActorId(user: { id: string | number }): number | null {
  const id = Number(user.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}
