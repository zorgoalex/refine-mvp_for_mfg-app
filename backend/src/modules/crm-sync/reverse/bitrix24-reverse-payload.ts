import { createHash } from 'node:crypto';
import { ApiError } from '../../../common/errors/api-error';
import type {
  Bitrix24InboundEventPayload,
  Bitrix24InstallationPayload,
  Bitrix24ReverseObjectType,
  Bitrix24ReverseOperation,
} from './bitrix24-reverse.types';

const EVENTS: Readonly<Record<string, {
  objectType: Bitrix24ReverseObjectType;
  operation: Bitrix24ReverseOperation;
}>> = {
  ONCRMCONTACTADD: { objectType: 'contact', operation: 'upsert' },
  ONCRMCONTACTUPDATE: { objectType: 'contact', operation: 'upsert' },
  ONCRMCONTACTDELETE: { objectType: 'contact', operation: 'delete' },
  ONCRMCOMPANYADD: { objectType: 'company', operation: 'upsert' },
  ONCRMCOMPANYUPDATE: { objectType: 'company', operation: 'upsert' },
  ONCRMCOMPANYDELETE: { objectType: 'company', operation: 'delete' },
  ONCRMDEALADD: { objectType: 'deal', operation: 'upsert' },
  ONCRMDEALUPDATE: { objectType: 'deal', operation: 'upsert' },
  ONCRMDEALDELETE: { objectType: 'deal', operation: 'delete' },
  ONCRMDEALMOVETOCATEGORY: { objectType: 'deal', operation: 'upsert' },
};

export const BITRIX24_REVERSE_EVENTS = Object.freeze(Object.keys(EVENTS));

export function parseBitrix24InstallationPayload(
  body: unknown,
): Bitrix24InstallationPayload {
  const root = record(body, 'installation body');
  const auth = record(root.auth, 'installation auth');
  return {
    accessToken: requiredString(auth, 'access_token', 1, 4096),
    refreshToken: requiredString(auth, 'refresh_token', 1, 4096),
    expiresIn: requiredInteger(auth, 'expires_in', 60, 86400),
    domain: normalizeDomain(requiredString(auth, 'domain', 3, 255)),
    memberId: requiredString(auth, 'member_id', 8, 255),
    applicationStatus: requiredString(auth, 'status', 1, 8),
    applicationToken: requiredString(auth, 'application_token', 8, 4096),
  };
}

export function parseBitrix24InboundEvent(
  body: unknown,
  now = new Date(),
): Bitrix24InboundEventPayload {
  const root = record(body, 'event body');
  const eventName = requiredString(root, 'event', 1, 100).toUpperCase();
  const event = EVENTS[eventName];
  if (!event) {
    throw invalidPayload('Unsupported Bitrix24 event');
  }

  const data = record(root.data, 'event data');
  const fields = optionalRecord(data.FIELDS) ?? optionalRecord(data.fields) ?? data;
  const rawId = fields.ID ?? fields.id;
  const bitrixId = String(rawId ?? '');
  if (!/^[1-9][0-9]*$/.test(bitrixId)) {
    throw invalidPayload('Invalid Bitrix24 object ID');
  }

  const ts = numberValue(root.ts);
  if (!Number.isInteger(ts) || ts <= 0) {
    throw invalidPayload('Invalid Bitrix24 event timestamp');
  }
  const eventTimestamp = new Date(ts * 1000);
  if (!Number.isFinite(eventTimestamp.getTime())) {
    throw invalidPayload('Invalid Bitrix24 event timestamp');
  }
  if (eventTimestamp.getTime() > now.getTime() + 5 * 60_000) {
    throw invalidPayload('Bitrix24 event timestamp is in the future');
  }

  const auth = record(root.auth, 'event auth');
  const memberId = requiredString(auth, 'member_id', 8, 255);
  const domain = normalizeDomain(requiredString(auth, 'domain', 3, 255));
  const applicationToken = requiredString(auth, 'application_token', 8, 4096);
  const fingerprint = createHash('sha256')
    .update(`${memberId}|${eventName}|${bitrixId}|${ts}`, 'utf8')
    .digest('hex');

  return {
    eventName,
    objectType: event.objectType,
    operation: event.operation,
    bitrixId,
    eventTimestamp,
    memberId,
    domain,
    applicationToken,
    fingerprint,
    // Never persist auth: event callbacks may contain access/refresh tokens.
    storedPayload: {
      event: eventName,
      data: { id: bitrixId },
      ts,
    },
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  const parsed = optionalRecord(value);
  if (!parsed) throw invalidPayload(`Invalid ${label}`);
  return parsed;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(
  source: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): string {
  const value = source[field];
  if (typeof value !== 'string') throw invalidPayload(`Invalid ${field}`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw invalidPayload(`Invalid ${field}`);
  }
  return trimmed;
}

function requiredInteger(
  source: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number {
  const value = numberValue(source[field]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalidPayload(`Invalid ${field}`);
  }
  return value;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' || typeof value === 'string'
    ? Number(value)
    : Number.NaN;
}

function normalizeDomain(value: string): string {
  const domain = value.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes('/') || domain.includes('..')) {
    throw invalidPayload('Invalid domain');
  }
  return domain;
}

function invalidPayload(message: string): ApiError {
  return new ApiError(400, 'BITRIX24_INVALID_CALLBACK', message);
}
