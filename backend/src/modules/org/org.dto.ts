import { ApiError } from '../../common/errors/api-error';
import type { ReplaceIdSetRequestDto, UpdateDirectionRequestDto } from './org.types';

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(422, 'ORG_INVALID_BODY', 'Request body must be an object');
  }
  return body as Record<string, unknown>;
}

function parseName(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw new ApiError(422, 'ORG_INVALID_NAME', 'name must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ApiError(422, 'ORG_INVALID_NAME', 'name must not be empty');
  if (trimmed.length > 128) throw new ApiError(422, 'ORG_INVALID_NAME', 'name must be <= 128 chars');
  return trimmed;
}

function parseDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ApiError(422, 'ORG_INVALID_DESCRIPTION', 'description must be a string');
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseIsActive(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ApiError(422, 'ORG_INVALID_IS_ACTIVE', 'isActive must be a boolean');
  return value;
}

function parsePositiveIntId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ApiError(422, 'ORG_INVALID_ID', 'id must be a positive integer');
  }
  return value;
}

export interface ParsedCreateDirection {
  name: string;
  description: string | null;
  isActive: boolean;
}

export function parseCreateDirectionRequest(body: unknown): ParsedCreateDirection {
  const obj = asObject(body);
  return {
    name: parseName(obj.name, true) as string,
    description: parseDescription(obj.description),
    isActive: parseIsActive(obj.isActive, true),
  };
}

export function parseUpdateDirectionRequest(body: unknown): UpdateDirectionRequestDto {
  const obj = asObject(body);
  const result: UpdateDirectionRequestDto = {};
  if (obj.name !== undefined) result.name = parseName(obj.name, true);
  if (obj.description !== undefined) result.description = parseDescription(obj.description);
  if (obj.isActive !== undefined) result.isActive = parseIsActive(obj.isActive, true);
  if (Object.keys(result).length === 0) {
    throw new ApiError(422, 'ORG_EMPTY_UPDATE', 'At least one field must be provided');
  }
  return result;
}

export function parseReplaceIdSetRequest(body: unknown): ReplaceIdSetRequestDto {
  const obj = asObject(body);
  if (
    typeof obj.idempotencyKey !== 'string' ||
    obj.idempotencyKey.trim().length === 0 ||
    obj.idempotencyKey.length > 200
  ) {
    throw new ApiError(422, 'ORG_INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must be a non-empty string (<= 200 chars)');
  }
  if (!Array.isArray(obj.ids)) throw new ApiError(422, 'ORG_INVALID_IDS', 'ids must be an array');
  if (obj.ids.length > 500) throw new ApiError(422, 'ORG_TOO_MANY_IDS', 'ids must contain <= 500 items');
  const ids = [...new Set(obj.ids.map(parsePositiveIntId))].sort((a, b) => a - b);
  const reason =
    obj.reason === undefined || obj.reason === null
      ? null
      : typeof obj.reason === 'string'
        ? obj.reason.trim() || null
        : (() => {
            throw new ApiError(422, 'ORG_INVALID_REASON', 'reason must be a string');
          })();
  if (reason !== null && reason.length > 500) throw new ApiError(422, 'ORG_INVALID_REASON', 'reason must be <= 500 chars');
  return { idempotencyKey: obj.idempotencyKey, ids, reason };
}

/**
 * Hard delete is a secondary, confirm-guarded action. The backend is the
 * authority: it requires an explicit confirm flag and rejects a bare delete
 * with 422, so the guard is not merely a frontend affordance.
 */
export function parseDeleteConfirmation(confirm: unknown): void {
  if (confirm !== 'true' && confirm !== true) {
    throw new ApiError(422, 'ORG_DELETE_NOT_CONFIRMED', 'Hard delete requires confirm=true');
  }
}

export function parseDirectionIdParam(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > 32767) {
    throw new ApiError(400, 'ORG_INVALID_DIRECTION_ID', 'Invalid direction id');
  }
  return id;
}

export function parseWorkshopIdParam(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0 || id > 32767) {
    throw new ApiError(400, 'ORG_INVALID_WORKSHOP_ID', 'Invalid workshop id');
  }
  return id;
}
