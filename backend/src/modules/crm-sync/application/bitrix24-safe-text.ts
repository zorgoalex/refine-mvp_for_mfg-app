/**
 * Text that ERP sends to Bitrix24 people (timeline comments, notifications) is built from ERP data that users
 * typed: order names, user names, payment type names. Such a value may carry a pasted link, a webhook URL with
 * its secret, an e-mail or a BB-code. Every dynamic value goes through `safeOutboundText` before it is stored and
 * again when it is rendered; the only links in an outgoing text are the ones the code builds itself.
 */

const MAX_LENGTH = 120;
const HIDDEN = '…';

// A credential name followed by `:` or `=` (quoted or not, JSON-shaped too): everything after it is hidden — the
// value's own quoting, escapes and punctuation are never trusted to find where it ends.
const CREDENTIAL_ASSIGNMENT =
  /["']?\b(auth|token|access_token|refresh_token|application_token|app_sid|client_secret|secret|password|passwd|pwd|api_?key|key)\b["']?\s*[:=][\s\S]*$/iu;

const PATTERNS: RegExp[] = [
  // Any URL with a scheme, then bare www-hosts and host.tld/path fragments.
  /\S*:\/\/\S*/giu,
  /\bwww\.\S+/giu,
  /\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}\/\S*/giu,
  // E-mail addresses.
  /[^\s@]+@[^\s@]+\.[^\s@]+/gu,
  // A webhook path tail without its host (/1/k3x9…/); plain fractions like 1/2/3 stay.
  /\/\d+\/(?=[A-Za-z0-9_-]*[A-Za-z_])[A-Za-z0-9_-]{6,}\/?/g,
];

export function safeOutboundText(value: unknown, maxLength = MAX_LENGTH): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // Credential assignments first, whatever the shape of the value (access_token=…, password: …, "secret":"…").
  text = text.replace(CREDENTIAL_ASSIGNMENT, (_match, key: string) => `${key}=${HIDDEN}`);
  for (const pattern of PATTERNS) text = text.replace(pattern, HIDDEN);
  // Token-like runs (approved rule): any run of 20+ [A-Za-z0-9_-]; plus shorter runs holding a 16+ segment of
  // letters AND digits (a Bitrix24 webhook code is 16). Long Latin names written with hyphens are masked too:
  // safety over readability (order names are mostly Cyrillic).
  text = text.replace(/[A-Za-z0-9_-]{16,}/g, (run) =>
    run.length >= 20 || run.split(/[-_]/).some((segment) => segment.length >= 16 && /[0-9]/.test(segment) && /[A-Za-z]/.test(segment))
      ? HIDDEN
      : run);
  text = text
    .replace(/[[\]]/g, '')
    // Control characters (including line breaks): one line per value.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}${HIDDEN}` : text;
}

