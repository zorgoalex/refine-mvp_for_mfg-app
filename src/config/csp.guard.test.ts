import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Vercel Content Security Policy', () => {
  it('allows blob PDFs inside the cut preview iframe', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      headers?: Array<{ headers?: Array<{ key: string; value: string }> }>;
    };
    const csp = vercel.headers
      ?.flatMap((entry) => entry.headers ?? [])
      .find((header) => header.key === 'Content-Security-Policy')?.value;

    expect(csp).toContain("frame-src 'self' blob:");
  });
});
