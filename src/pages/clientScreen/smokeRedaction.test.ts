import { describe, expect, it } from 'vitest';
// @ts-ignore plain ESM helper of the browser scripts, no types
import { printableError } from '../../../tests/helpers/redactSecrets.mjs';

describe('printable errors of the deployment smoke script', () => {
  it('prints one line without the credential, even when the error carries request headers in its call log', () => {
    const secret = 'dummy-bypass-secret-0123456789';
    const error = new Error(`apiRequestContext.get: Timeout 30000ms exceeded.\nCall log:\n  - → GET https://example.test/assets/a.js\n  -   x-vercel-protection-bypass: ${secret}`);
    const printed = printableError(error, [secret]);
    expect(printed).toBe('Error: apiRequestContext.get: Timeout 30000ms exceeded.');
    expect(printableError(new Error(`failed with ${secret} in the first line`), [secret])).toBe('Error: failed with [redacted] in the first line');
    expect(printableError(new Error(`x ${secret} y ${secret}`), [secret, undefined, ''])).not.toContain(secret);
    expect(printableError('plain', [secret])).toBe('Error: plain');
    expect(printableError(new Error('a'.repeat(1000)), []).length).toBeLessThanOrEqual(300);
  });
});
