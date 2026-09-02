import { authStorage } from '../utils/auth';
import { getRuntimeHasuraUrl } from '../config/runtimeConfig';

type HasuraReportErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'CONFIGURATION_ERROR'
  | 'HTTP_ERROR'
  | 'GRAPHQL_ERROR';

/**
 * Read-only Hasura report/reference query helper. ERP retains Hasura for
 * read/report/reference (CLAUDE.md principle #1); this isolates those reads
 * out of page components so no new page-level Hasura fetch exists. Never use
 * this for mutations.
 */
export class HasuraReportError extends Error {
  code: HasuraReportErrorCode;
  constructor(code: HasuraReportErrorCode, message: string) {
    super(message);
    this.name = 'HasuraReportError';
    this.code = code;
  }
}

function normalizeUrl(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getConfiguredHasuraUrl(): string | null {
  return (
    normalizeUrl(getRuntimeHasuraUrl()) ??
    normalizeUrl((import.meta as { env?: Record<string, unknown> }).env?.VITE_HASURA_GRAPHQL_URL) ??
    normalizeUrl(
      (globalThis as { process?: { env?: Record<string, unknown> } }).process?.env
        ?.VITE_HASURA_GRAPHQL_URL,
    )
  );
}

function parseResponseBody(rawBody: string): Record<string, unknown> | null {
  if (!rawBody.trim()) return null;

  try {
    const parsed = JSON.parse(rawBody);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function hasuraReportQuery<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const token = authStorage.getAccessToken();
  if (!token) {
    throw new HasuraReportError('NOT_AUTHENTICATED', 'NOT_AUTHENTICATED');
  }
  const hasuraUrl = getConfiguredHasuraUrl();
  if (!hasuraUrl) {
    throw new HasuraReportError('CONFIGURATION_ERROR', 'Hasura report URL is not configured');
  }

  const response = await fetch(hasuraUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const rawBody = await response.text();
  const body = parseResponseBody(rawBody);
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const firstError = errors[0];
  const errorMessage = firstError && typeof firstError === 'object' && 'message' in firstError
    ? String(firstError.message)
    : null;

  if (!response.ok) {
    throw new HasuraReportError(
      'HTTP_ERROR',
      errorMessage || `Hasura report request failed (HTTP ${response.status})`,
    );
  }
  if (!body) {
    throw new HasuraReportError('GRAPHQL_ERROR', 'Hasura report returned an invalid JSON response');
  }
  if (errors.length) {
    throw new HasuraReportError('GRAPHQL_ERROR', errorMessage || 'Hasura report query failed');
  }
  return body.data as T;
}
