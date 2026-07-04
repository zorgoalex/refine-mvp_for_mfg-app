import { ApiError } from '../../../common/errors/api-error';

export interface WorkosClientOptions {
  apiBase: string;
  apiKey: string;
  clientId: string;
  redirectUri: string;
}

export interface WorkosIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  /** WorkOS AuthKit session id (sid claim), used for provider-side logout. */
  providerSessionId: string | null;
}

interface WorkosAuthenticateResponse {
  user?: {
    id?: string;
    email?: string;
    email_verified?: boolean;
    first_name?: string | null;
    last_name?: string | null;
  };
  access_token?: string;
}

export class WorkosApiClient {
  constructor(
    private readonly options: WorkosClientOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  buildAuthorizeUrl(state: string): string {
    const url = new URL('/user_management/authorize', this.options.apiBase);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.options.redirectUri);
    url.searchParams.set('provider', 'authkit');
    url.searchParams.set('state', state);
    return url.toString();
  }

  buildLogoutUrl(providerSessionId: string): string {
    const url = new URL('/user_management/sessions/logout', this.options.apiBase);
    url.searchParams.set('session_id', providerSessionId);
    return url.toString();
  }

  async authenticateWithCode(code: string): Promise<WorkosIdentity> {
    let response: Response;

    try {
      response = await this.fetchImpl(new URL('/user_management/authenticate', this.options.apiBase), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: this.options.clientId,
          client_secret: this.options.apiKey,
          grant_type: 'authorization_code',
          code,
        }),
      });
    } catch (error) {
      throw new ApiError(502, 'WORKOS_UNAVAILABLE', 'SSO-провайдер недоступен', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const parsed = parseJson(body);
      const errorCode = typeof parsed?.error === 'string' ? parsed.error : undefined;

      // Only the status and the parsed stable error code are logged: the raw
      // upstream body is untrusted and could echo the one-time code or other
      // sensitive request fields.
      // eslint-disable-next-line no-console
      console.error(
        `[workos] authenticate failed status=${response.status} error=${errorCode ?? 'unknown'}`,
      );

      if (response.status === 400 && errorCode === 'invalid_grant') {
        throw new ApiError(401, 'WORKOS_CODE_INVALID', 'Код авторизации недействителен или истёк');
      }

      throw new ApiError(502, 'WORKOS_UPSTREAM_ERROR', 'SSO-провайдер вернул ошибку');
    }

    const payload = (await response.json()) as WorkosAuthenticateResponse;
    const user = payload.user;

    if (!user?.id || !user.email) {
      throw new ApiError(502, 'WORKOS_UPSTREAM_ERROR', 'SSO-провайдер вернул неполный ответ');
    }

    return {
      sub: user.id,
      email: user.email,
      emailVerified: user.email_verified === true,
      firstName: user.first_name ?? null,
      lastName: user.last_name ?? null,
      providerSessionId: extractSessionId(payload.access_token),
    };
  }
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Reads the sid claim from the WorkOS access token payload. The token is only
 * decoded (not verified): it arrived over TLS directly from WorkOS in the
 * code-exchange response, and the sid is used solely to build a logout URL.
 */
function extractSessionId(accessToken: string | undefined): string | null {
  if (!accessToken) {
    return null;
  }

  const parts = accessToken.split('.');

  if (parts.length !== 3) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      sid?: unknown;
    };
    return typeof payload.sid === 'string' && payload.sid ? payload.sid : null;
  } catch {
    return null;
  }
}
