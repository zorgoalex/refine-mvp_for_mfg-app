import { authStorage } from '../utils/auth';

/**
 * Read-only Hasura report/reference query helper. ERP retains Hasura for
 * read/report/reference (CLAUDE.md principle #1); this isolates those reads
 * out of page components so no new page-level Hasura fetch exists. Never use
 * this for mutations.
 */
export class HasuraReportError extends Error {
  code: 'NOT_AUTHENTICATED' | 'GRAPHQL_ERROR';
  constructor(code: 'NOT_AUTHENTICATED' | 'GRAPHQL_ERROR', message: string) {
    super(message);
    this.name = 'HasuraReportError';
    this.code = code;
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
  const response = await fetch(import.meta.env.VITE_HASURA_GRAPHQL_URL as string, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body?.errors?.length) {
    throw new HasuraReportError('GRAPHQL_ERROR', body.errors[0]?.message || 'Hasura report query failed');
  }
  return body.data as T;
}
