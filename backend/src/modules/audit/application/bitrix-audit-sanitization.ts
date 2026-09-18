import { redactLogValue } from '../../../common/logging/redaction';

/** Also applies to historical errors. Sanitize before any presentation truncation. */
export function sanitizeBitrixAudit(value: unknown): unknown {
  if (typeof value === 'string')
    return redactLogValue(
      value
        .replace(/(\/rest\/\d+\/)[^/\s?"'<>]+/gi, '$1[REDACTED]')
        .replace(
          /\b(auth|APP_SID|application_token|access_token|refresh_token)\b(["']?\s*[:=]\s*["']?)[^\s&,;"'<>]+/gi,
          '$1$2[REDACTED]'
        )
    );
  if (Array.isArray(value)) return value.map(sanitizeBitrixAudit);
  if (value && typeof value === 'object') {
    const redacted = redactLogValue(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(redacted).map(([key, nested]) => [
        key,
        /^(auth|APP_SID)$/i.test(key)
          ? '[REDACTED]'
          : sanitizeBitrixAudit(nested),
      ])
    );
  }
  return value;
}

export function safeBitrixError(value: string): string {
  return String(sanitizeBitrixAudit(value)).slice(0, 1000);
}
