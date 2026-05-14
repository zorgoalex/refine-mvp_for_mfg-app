import crypto from 'crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

type EnvSource = Record<string, string | undefined>;

const ENABLE_FLAGS = ['ENABLE_LEGACY_VERCEL_FUNCTIONS', 'ENABLE_LEGACY_API'];
const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const PRODUCTION_ENV_VALUES = new Set(['production', 'prod', 'staging', 'stage', 'preview']);

export const LEGACY_DISABLED_STATUS = 410;
export const LEGACY_DISABLED_CODE = 'LEGACY_VERCEL_FUNCTION_DISABLED';
export const LEGACY_DISABLED_MESSAGE =
  'Legacy Vercel Function is disabled. Use the NestJS backend API.';

export interface LegacyGateResult {
  disabled: boolean;
  requestId: string;
}

export function shouldDisableLegacyVercelFunction(
  env: EnvSource = process.env,
): boolean {
  if (ENABLE_FLAGS.some((key) => readBooleanEnv(env[key], false))) {
    return false;
  }

  return [
    env.VERCEL_ENV,
    env.APP_ENV,
    env.BACKEND_ENV,
    env.NODE_ENV,
  ].some((value) => isProductionLikeEnv(value));
}

export function handleDisabledLegacyVercelFunction(
  req: VercelRequest,
  res: VercelResponse,
  env: EnvSource = process.env,
): LegacyGateResult {
  const requestId = getOrCreateRequestId(req);
  const disabled = shouldDisableLegacyVercelFunction(env);

  if (!disabled) {
    return { disabled: false, requestId };
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('x-request-id', requestId);
    res.setHeader('Allow', 'OPTIONS');
    res.status(204).end();
    return { disabled: true, requestId };
  }

  res.setHeader('x-request-id', requestId);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(LEGACY_DISABLED_STATUS).json({
    error: {
      code: LEGACY_DISABLED_CODE,
      message: LEGACY_DISABLED_MESSAGE,
      requestId,
    },
  });

  return { disabled: true, requestId };
}

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;

  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  return fallback;
}

function isProductionLikeEnv(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false;
  return PRODUCTION_ENV_VALUES.has(value.trim().toLowerCase());
}

function getOrCreateRequestId(req: VercelRequest): string {
  const header = req.headers['x-request-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && typeof header[0] === 'string' && header[0].trim()) {
    return header[0].trim();
  }

  return `req_${crypto.randomUUID()}`;
}
