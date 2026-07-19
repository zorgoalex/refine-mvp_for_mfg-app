import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { stableSerialize } from './pdf-table-patterns.controller';

const databaseUrl = process.env.PDF_PATTERN_INTEGRATION_DATABASE_URL
  ?? process.env.TEST_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;

describeIntegration('Basis PDF pattern persistence (integration)', () => {
  afterAll(async () => pool?.end());

  it('round-trips JSONB independent of object key order', async () => {
    const fingerprint = randomBytes(32).toString('hex');
    const signature = {
      fingerprintVersion: 1,
      parserMajor: 1,
      headerBandCount: 1,
      columns: [{ header: 'name', relativeStart: 0, relativeEnd: 1 }],
    };
    try {
      await pool!.query(
        `INSERT INTO bazis_pdf_table_patterns
          (fingerprint,fingerprint_version,parser_major,signature_json,mapping_json,mapping_hash)
         VALUES ($1,1,1,$2::jsonb,$3::jsonb,$4)`,
        [
          fingerprint,
          JSON.stringify(signature),
          JSON.stringify({ schemaVersion: 1, columns: [{ columnIndex: 0, target: 'name' }] }),
          createHash('sha256').update('mapping').digest('hex'),
        ],
      );
      const result = await pool!.query<{ signature_json: unknown }>(
        'SELECT signature_json FROM bazis_pdf_table_patterns WHERE fingerprint=$1',
        [fingerprint],
      );
      expect(stableSerialize(result.rows[0].signature_json)).toBe(stableSerialize(signature));
    } finally {
      await pool!.query('DELETE FROM bazis_pdf_table_patterns WHERE fingerprint=$1', [fingerprint]);
    }
  });

  it('allows only one winner for concurrent structural inserts', async () => {
    const fingerprint = randomBytes(32).toString('hex');
    const insert = () => pool!.query(
      `INSERT INTO bazis_pdf_table_patterns
        (fingerprint,fingerprint_version,parser_major,signature_json,mapping_json,mapping_hash)
       VALUES ($1,1,1,'{"columns":[]}'::jsonb,'{"columns":[]}'::jsonb,$2)
       ON CONFLICT (fingerprint_version,parser_major,fingerprint) DO NOTHING
       RETURNING bazis_pdf_table_pattern_id`,
      [fingerprint, createHash('sha256').update('mapping').digest('hex')],
    );
    try {
      const results = await Promise.all([insert(), insert()]);
      expect(results.map(result => result.rowCount).sort()).toEqual([0, 1]);
    } finally {
      await pool!.query('DELETE FROM bazis_pdf_table_patterns WHERE fingerprint=$1', [fingerprint]);
    }
  });
});
