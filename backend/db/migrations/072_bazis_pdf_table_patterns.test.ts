import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('migration 072 Basis PDF table patterns', () => {
  const sql = readFileSync(resolve(__dirname, '072_bazis_pdf_table_patterns.sql'), 'utf8');

  it('stores reusable structural patterns with approval and optimistic versioning', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS bazis_pdf_table_patterns/i);
    expect(sql).toMatch(/signature_json\s+JSONB NOT NULL/i);
    expect(sql).toMatch(/mapping_json\s+JSONB NOT NULL/i);
    expect(sql).toMatch(/approval_status\s+VARCHAR\(16\).*DEFAULT 'pending'/i);
    expect(sql).toMatch(/version\s+INTEGER NOT NULL DEFAULT 1/i);
    expect(sql).toMatch(/pending.*approved.*rejected/is);
  });

  it('does not define document-content storage columns', () => {
    expect(sql).not.toMatch(/\b(pdf_bytes|file_name|file_hash|document_hash|raw_rows|raw_text)\b/i);
  });
});
