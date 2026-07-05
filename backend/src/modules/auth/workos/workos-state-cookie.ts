import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { DEFAULT_API_PREFIX, getAuthCookiePath } from '../../../config/api-prefix';

export const WORKOS_STATE_COOKIE_NAME = 'erp_workos_state';

const STATE_TTL_MS = 10 * 60 * 1000;

export type WorkosFlowMode = 'login' | 'link';

export interface WorkosStatePayload {
  state: string;
  mode: WorkosFlowMode;
  /** Bound ERP session id; required and revalidated for mode='link'. */
  sessionId?: string;
  expiresAt: number;
}

export interface WorkosStateCookie {
  name: typeof WORKOS_STATE_COOKIE_NAME;
  value: string;
  options: {
    httpOnly: true;
    secure: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    path: string;
    maxAge: number;
  };
}

/**
 * The signed cookie only binds the OAuth round-trip to an intent (login vs
 * link) and, for link mode, to a session id. It is never trusted alone: the
 * link callback additionally requires a live bearer session that matches.
 */
export function createWorkosState(
  secret: string,
  mode: WorkosFlowMode,
  sessionId?: string,
): { state: string; cookieValue: string } {
  const payload: WorkosStatePayload = {
    state: randomUUID(),
    mode,
    sessionId,
    expiresAt: Date.now() + STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { state: payload.state, cookieValue: `${encoded}.${sign(secret, encoded)}` };
}

export function verifyWorkosState(secret: string, cookieValue: string | undefined): WorkosStatePayload | null {
  if (!cookieValue) {
    return null;
  }

  const separator = cookieValue.lastIndexOf('.');

  if (separator <= 0) {
    return null;
  }

  const encoded = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  const expected = sign(secret, encoded);

  if (signature.length !== expected.length) {
    return null;
  }

  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as WorkosStatePayload;

    if (typeof payload.state !== 'string' || !payload.state) {
      return null;
    }
    if (payload.mode !== 'login' && payload.mode !== 'link') {
      return null;
    }
    if (typeof payload.expiresAt !== 'number' || payload.expiresAt < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function createWorkosStateCookie(
  cookieValue: string,
  options: { nodeEnv: string; apiPrefix?: string; secure?: boolean; sameSite?: 'lax' | 'strict' | 'none' },
): WorkosStateCookie {
  return {
    name: WORKOS_STATE_COOKIE_NAME,
    value: cookieValue,
    options: {
      httpOnly: true,
      secure: options.secure ?? options.nodeEnv === 'production',
      sameSite: options.sameSite ?? 'lax',
      path: getAuthCookiePath(options.apiPrefix ?? DEFAULT_API_PREFIX),
      maxAge: STATE_TTL_MS,
    },
  };
}

export function createClearWorkosStateCookie(
  options: { nodeEnv: string; apiPrefix?: string; secure?: boolean; sameSite?: 'lax' | 'strict' | 'none' },
): WorkosStateCookie {
  return {
    ...createWorkosStateCookie('', options),
    value: '',
    options: { ...createWorkosStateCookie('', options).options, maxAge: 0 },
  };
}

function sign(secret: string, encoded: string): string {
  return createHmac('sha256', secret).update(encoded).digest('base64url');
}
