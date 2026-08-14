import { ApiError } from '../../../common/errors/api-error';

export interface WorkosClientOptions {
  apiBase: string;
  apiKey: string;
  clientId: string;
  redirectUri: string;
}

export interface WorkosAuthorizeOptions {
  /**
   * Force AuthKit to actively authenticate instead of silently reusing its
   * browser session. Link flows need this so the user can choose another
   * social account; ordinary login should keep seamless SSO.
   */
  forceFreshAuthentication?: boolean;
  /**
   * Ask AuthKit/the upstream provider to show an account chooser. This is
   * used after an unlinked identity was returned from a still-active browser
   * session, and for link flows where choosing the exact account matters.
   */
  selectAccount?: boolean;
}

export interface WorkosIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  /** WorkOS AuthKit session id (sid claim), used for provider-side logout. */
  providerSessionId: string | null;
  /** WorkOS authentication_method (Password/GoogleOAuth/…), null if absent. */
  authMethod: string | null;
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
  authentication_method?: string;
}

export class WorkosApiClient {
  constructor(
    private readonly options: WorkosClientOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  buildAuthorizeUrl(state: string, authorizeOptions: WorkosAuthorizeOptions = {}): string {
    const url = new URL('/user_management/authorize', this.options.apiBase);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', this.options.redirectUri);
    // The hosted AuthKit provider may reuse its own active user before it
    // reaches Google, even when Google-specific query parameters are present.
    // A retry that explicitly switches accounts must enter Google directly.
    url.searchParams.set('provider', authorizeOptions.selectAccount ? 'GoogleOAuth' : 'authkit');
    url.searchParams.set('state', state);
    if (authorizeOptions.forceFreshAuthentication) {
      // WorkOS documents max_age=0 as the supported way to require a fresh
      // AuthKit authentication. This prevents "Привязать ещё" from silently
      // returning the identity already active in the provider session.
      url.searchParams.set('max_age', '0');
    }
    if (authorizeOptions.selectAccount) {
      // `prompt` at the AuthKit level does not force the upstream social
      // provider to switch accounts. WorkOS forwards provider-specific
      // parameters only through provider_query_params bracket notation.
      url.searchParams.set('provider_query_params[prompt]', 'select_account');
    }
    return url.toString();
  }

  buildLogoutUrl(providerSessionId: string): string {
    return buildWorkosLogoutUrl(this.options.apiBase, providerSessionId);
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

    let payload: WorkosAuthenticateResponse;

    try {
      payload = (await response.json()) as WorkosAuthenticateResponse;
    } catch {
      // A 200 with a malformed body (CDN error page etc.) is an upstream
      // failure, not an internal 500.
      throw new ApiError(502, 'WORKOS_UPSTREAM_ERROR', 'SSO-провайдер вернул некорректный ответ');
    }

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
      authMethod:
        typeof payload.authentication_method === 'string' ? payload.authentication_method : null,
    };
  }
}

/**
 * Pure URL constructor: needs only the pinned WORKOS_API_BASE, so it stays
 * available for logging out already-issued SSO sessions even while the
 * WorkOS entrypoints are rolled back (flag off / partial 052 schema).
 */
export function buildWorkosLogoutUrl(apiBase: string, providerSessionId: string): string {
  const url = new URL('/user_management/sessions/logout', apiBase);
  url.searchParams.set('session_id', providerSessionId);
  return url.toString();
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
