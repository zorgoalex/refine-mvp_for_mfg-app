const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /password_hash/i,
  /token/i,
  /authorization/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /secret/i,
  /api[_-]?key/i,
  /gas[_-]?api[_-]?key/i,
  /client[_-]?secret/i,
];

const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const AUTHORIZATION_HEADER_PATTERN =
  /\bAuthorization\s*:\s*(?!Bearer\s+\[REDACTED\])(?:(?:Basic|Digest|Token)\s+)?[^\s,;&]+/gi;
const QUERY_SECRET_PATTERN = /\b(access_token|refresh_token|password|api_key|secret)=([^&\s]+)/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const INLINE_SECRET_ASSIGNMENT_PATTERN =
  /\b(x[-_]?api[-_]?key|api[-_]?key|cookie|set-cookie|password|client[_-]?secret|secret)\b(\s*[:=]\s*)([^\s,;&]+)/gi;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function redactString(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [REDACTED]')
    .replace(AUTHORIZATION_HEADER_PATTERN, 'Authorization: [REDACTED]')
    .replace(QUERY_SECRET_PATTERN, '$1=[REDACTED]')
    .replace(JWT_PATTERN, REDACTED)
    .replace(INLINE_SECRET_ASSIGNMENT_PATTERN, '$1$2[REDACTED]');
}

export function redactLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, seen));
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  const output: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactLogValue(nestedValue, seen);
  }

  return output;
}

export function redactLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redactLogValue(fields) as Record<string, unknown>;
}
