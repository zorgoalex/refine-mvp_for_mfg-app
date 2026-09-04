import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../../../common/errors/api-error';

const POSITIVE_ID = /^[1-9][0-9]*$/;
const MAX_PLACEMENT_OPTIONS_BYTES = 16_384;

const CALLBACK_FIELDS = new Map<string, string>([
  ['auth_id', 'accessToken'],
  ['access_token', 'accessToken'],
  ['refresh_id', 'refreshToken'],
  ['refresh_token', 'refreshToken'],
  ['auth_expires', 'expiresIn'],
  ['expires_in', 'expiresIn'],
  ['domain', 'domain'],
  ['member_id', 'memberId'],
  ['status', 'status'],
  ['application_token', 'applicationToken'],
  ['application_scope', 'applicationScope'],
  ['placement', 'placement'],
  ['placement_options', 'placementOptions'],
]);

export interface Bitrix24WidgetCallback {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  domain: string;
  memberId: string;
  applicationToken: string;
  applicationScope: readonly string[];
  placement: 'CRM_DEAL_DETAIL_TAB';
  dealId: string;
  status: 'L';
}

export interface CreateWidgetPaymentInput {
  amount: string;
  paymentDate: string;
  paySystemId: number;
  comment: string | null;
  expectedOrderVersion: number | null;
  confirmOverpayment: boolean;
}

export interface Bitrix24RuntimeAuth {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  domain: string;
  memberId: string;
  status: 'L';
}

export type ResolvePaymentAmbiguityInput =
  | {
      resolution: 'attach_existing';
      bitrixPaymentId: string;
      reason: string;
      expectedVersion: number;
    }
  | {
      resolution: 'confirm_absent';
      reason: string;
      expectedVersion: number;
    };

const createPaymentSchema = z.object({
  amount: z.string().trim().regex(/^(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$/),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paySystemId: z.coerce.number().int().positive(),
  comment: z.string().trim().max(1000).nullable().optional(),
  expectedOrderVersion: z.coerce.number().int().positive().nullable().optional(),
  confirmOverpayment: z.boolean().default(false),
}).strict();

const ambiguityResolutionSchema = z.discriminatedUnion('resolution', [
  z.object({
    resolution: z.literal('attach_existing'),
    bitrixPaymentId: z.coerce.string().regex(POSITIVE_ID),
    reason: z.string().trim().min(10).max(2000),
    expectedVersion: z.coerce.number().int().positive(),
  }).strict(),
  z.object({
    resolution: z.literal('confirm_absent'),
    reason: z.string().trim().min(10).max(2000),
    expectedVersion: z.coerce.number().int().positive(),
  }).strict(),
]);

export function parseCreateWidgetPaymentInput(body: unknown): CreateWidgetPaymentInput {
  const parsed = createPaymentSchema.safeParse(body);
  if (!parsed.success || Number(parsed.data?.amount ?? 0) <= 0) {
    throw validationError(parsed.success ? [{ path: ['amount'], message: 'amount must be positive' }] : parsed.error.issues);
  }
  const [year, month, day] = parsed.data.paymentDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw validationError([{ path: ['paymentDate'], message: 'paymentDate is invalid' }]);
  }
  return {
    amount: parsed.data.amount,
    paymentDate: parsed.data.paymentDate,
    paySystemId: parsed.data.paySystemId,
    comment: parsed.data.comment || null,
    expectedOrderVersion: parsed.data.expectedOrderVersion ?? null,
    confirmOverpayment: parsed.data.confirmOverpayment,
  };
}

export function parseResolvePaymentAmbiguityInput(
  body: unknown,
): ResolvePaymentAmbiguityInput {
  const parsed = ambiguityResolutionSchema.safeParse(body);
  if (!parsed.success) throw validationError(parsed.error.issues);
  return parsed.data;
}

export function parseWidgetCallback(
  query: unknown,
  body: unknown,
): Bitrix24WidgetCallback {
  const fromQuery = collectCallbackFields(query, 'query');
  const fromBody = collectCallbackFields(body, 'body');
  const merged = new Map(fromQuery);
  for (const [key, value] of fromBody) {
    const existing = merged.get(key);
    if (existing !== undefined && existing !== value) {
      throw new ApiError(
        400,
        'BITRIX24_WIDGET_CALLBACK_CONFLICT',
        `Bitrix24 callback field ${key} conflicts between query and body`,
      );
    }
    merged.set(key, value);
  }

  const placement = required(merged, 'placement', 1, 100).toUpperCase();
  if (placement !== 'CRM_DEAL_DETAIL_TAB') {
    throw invalidCallback('Unsupported Bitrix24 placement');
  }
  const rawOptions = required(
    merged,
    'placementOptions',
    2,
    MAX_PLACEMENT_OPTIONS_BYTES,
  );
  let options: unknown;
  try {
    options = JSON.parse(rawOptions);
  } catch {
    throw invalidCallback('Invalid PLACEMENT_OPTIONS');
  }
  if (!isRecord(options) || !POSITIVE_ID.test(String(options.ID ?? options.id ?? ''))) {
    throw invalidCallback('Invalid Bitrix24 Deal ID');
  }
  const status = required(merged, 'status', 1, 8).toUpperCase();
  if (status !== 'L') throw invalidCallback('Only a local Bitrix24 app is allowed');
  const expiresIn = Number(required(merged, 'expiresIn', 1, 10));
  if (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 86_400) {
    throw invalidCallback('Invalid AUTH_EXPIRES');
  }
  const applicationScope = required(merged, 'applicationScope', 1, 1000)
    .split(/[,\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const requiredScopes = ['crm', 'sale', 'pay_system', 'placement'];
  if (
    requiredScopes.some((scope) => !applicationScope.includes(scope)) ||
    !applicationScope.some((scope) => ['user_basic', 'user_brief', 'user'].includes(scope))
  ) {
    throw new ApiError(
      403,
      'BITRIX24_WIDGET_SCOPE_MISSING',
      'Bitrix24 application scopes are incomplete',
    );
  }
  return {
    accessToken: required(merged, 'accessToken', 8, 4096),
    refreshToken: required(merged, 'refreshToken', 8, 4096),
    expiresIn,
    domain: normalizeDomain(required(merged, 'domain', 3, 255)),
    memberId: required(merged, 'memberId', 8, 255),
    applicationToken: required(merged, 'applicationToken', 8, 4096),
    applicationScope,
    placement: 'CRM_DEAL_DETAIL_TAB',
    dealId: String(options.ID ?? options.id),
    status: 'L',
  };
}

export function parseRuntimeAuth(body: unknown): Bitrix24RuntimeAuth {
  if (!isRecord(body)) throw invalidCallback('Invalid Bitrix24 app callback');
  const auth = isRecord(body.auth) ? body.auth : body;
  const accessToken = scalar(auth.access_token ?? auth.AUTH_ID, 'access token', 8, 4096);
  const refreshToken = scalar(auth.refresh_token ?? auth.REFRESH_ID, 'refresh token', 8, 4096);
  const expiresIn = Number(auth.expires_in ?? auth.AUTH_EXPIRES);
  if (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 86_400) {
    throw invalidCallback('Invalid Bitrix24 app token expiry');
  }
  const status = scalar(auth.status ?? auth.STATUS, 'status', 1, 8).toUpperCase();
  if (status !== 'L') throw invalidCallback('Only a local Bitrix24 app is allowed');
  return {
    accessToken,
    refreshToken,
    expiresIn,
    domain: normalizeDomain(scalar(auth.domain ?? auth.DOMAIN, 'domain', 3, 255)),
    memberId: scalar(auth.member_id ?? auth.MEMBER_ID, 'member ID', 8, 255),
    status: 'L',
  };
}

export function parseWidgetAuthorization(value: unknown): string {
  if (typeof value !== 'string') throw widgetAuthError();
  const match = /^BitrixWidget ([A-Za-z0-9_-]{32,256})$/.exec(value.trim());
  if (!match) throw widgetAuthError();
  return match[1];
}

export function parseIdempotencyKey(value: unknown): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Idempotency-Key must be a UUID');
  }
  return parsed.data;
}

export function requestHash(input: CreateWidgetPaymentInput): string {
  return createHash('sha256')
    .update(JSON.stringify(input), 'utf8')
    .digest('hex');
}

function collectCallbackFields(value: unknown, label: string): Map<string, string> {
  if (!isRecord(value)) throw invalidCallback(`Invalid callback ${label}`);
  const result = new Map<string, string>();
  collectRecord(value, result);
  const auth = isRecord(value.auth) ? value.auth : null;
  if (auth) collectRecord(auth, result);
  return result;
}

function collectRecord(source: Record<string, unknown>, target: Map<string, string>): void {
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const canonical = CALLBACK_FIELDS.get(rawKey.toLowerCase());
    if (!canonical) continue;
    if (Array.isArray(rawValue) || isRecord(rawValue) || rawValue === undefined || rawValue === null) {
      throw invalidCallback(`Invalid duplicate callback field ${rawKey}`);
    }
    const value = String(rawValue).trim();
    const existing = target.get(canonical);
    if (existing !== undefined && existing !== value) {
      throw new ApiError(
        400,
        'BITRIX24_WIDGET_CALLBACK_CONFLICT',
        `Bitrix24 callback field ${rawKey} is duplicated`,
      );
    }
    target.set(canonical, value);
  }
}

function required(source: Map<string, string>, key: string, min: number, max: number): string {
  const value = source.get(key) ?? '';
  if (value.length < min || value.length > max) {
    throw invalidCallback(`Invalid Bitrix24 callback field ${key}`);
  }
  return value;
}

function scalar(value: unknown, key: string, min: number, max: number): string {
  if (Array.isArray(value) || isRecord(value) || value === undefined || value === null) {
    throw invalidCallback(`Invalid Bitrix24 app field ${key}`);
  }
  const result = String(value).trim();
  if (result.length < min || result.length > max) {
    throw invalidCallback(`Invalid Bitrix24 app field ${key}`);
  }
  return result;
}

function normalizeDomain(value: string): string {
  const domain = value.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes('..')) {
    throw invalidCallback('Invalid Bitrix24 domain');
  }
  return domain;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidCallback(message: string): ApiError {
  return new ApiError(400, 'BITRIX24_WIDGET_CALLBACK_INVALID', message);
}

function widgetAuthError(): ApiError {
  return new ApiError(401, 'BITRIX24_WIDGET_SESSION_EXPIRED', 'Bitrix24 widget session expired');
}

function validationError(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', 'Bitrix24 payment request is invalid', {
    errors: issues.map((issue) => ({ field: issue.path.join('.') || 'body', message: issue.message })),
  });
}
