import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import {
  canonicalSignature,
  PdfTablePatternsService,
  stableSerialize,
  validateMapping,
} from './pdf-table-patterns.controller';

const signature = {
  fingerprintVersion: 1 as const,
  parserMajor: 1 as const,
  headerBandCount: 1,
  columns: [
    { header: 'Наименование', relativeStart: 0, relativeEnd: 0.4 },
    { header: 'Количество', relativeStart: 0.4, relativeEnd: 0.7 },
    { header: 'Размер', relativeStart: 0.7, relativeEnd: 1 },
  ],
};
const mapping = {
  schemaVersion: 1 as const,
  columns: [
    { columnIndex: 0, target: 'name' as const },
    { columnIndex: 1, target: 'quantity' as const },
    { columnIndex: 2, target: 'compound_size' as const },
  ],
};
const importer = {
  id: '10',
  username: 'importer',
  role: 'manager' as const,
  roleId: 10,
  permissions: ['orders.import' as const],
};
const manager = {
  ...importer,
  id: '11',
  username: 'admin',
  permissions: ['orders.import' as const, 'bazis.manage' as const],
};

afterEach(() => vi.restoreAllMocks());

describe('Basis PDF table pattern contract', () => {
  it('canonicalizes only structural header geometry', () => {
    expect(canonicalSignature({
      fingerprintVersion: 1,
      parserMajor: 1,
      headerBandCount: 1,
      columns: [{ header: ' НАИМЕНОВАНИЕ! ', relativeStart: 0.10004, relativeEnd: 0.6 }],
    })).toEqual({
      fingerprintVersion: 1,
      parserMajor: 1,
      headerBandCount: 1,
      columns: [{ header: 'наименование', relativeStart: 0.1, relativeEnd: 0.6 }],
    });
  });

  it('rejects incomplete or duplicate mappings', () => {
    expect(() => validateMapping({
      schemaVersion: 1,
      columns: [
        { columnIndex: 0, target: 'name' },
        { columnIndex: 1, target: 'name' },
      ],
    })).toThrow(ApiError);
    expect(() => validateMapping({
      schemaVersion: 1,
      columns: [
        { columnIndex: 0, target: 'name' },
        { columnIndex: 1, target: 'quantity' },
        { columnIndex: 2, target: 'compound_size' },
      ],
    })).not.toThrow();
  });

  it('compares JSONB objects independently of key insertion order', () => {
    expect(stableSerialize({ columns: [{ relativeEnd: 1, header: 'x', relativeStart: 0 }] }))
      .toBe(stableSerialize({ columns: [{ header: 'x', relativeStart: 0, relativeEnd: 1 }] }));
  });

  it('requires exact mapping coverage for the structural signature', () => {
    const signature = canonicalSignature({
      fingerprintVersion: 1,
      parserMajor: 1,
      headerBandCount: 1,
      columns: [
        { header: 'name', relativeStart: 0, relativeEnd: 0.3 },
        { header: 'qty', relativeStart: 0.3, relativeEnd: 0.6 },
        { header: 'size', relativeStart: 0.6, relativeEnd: 1 },
      ],
    });
    expect(() => validateMapping({
      schemaVersion: 1,
      columns: [
        { columnIndex: 0, target: 'name' },
        { columnIndex: 1, target: 'quantity' },
        { columnIndex: 3, target: 'compound_size' },
      ],
    }, signature)).toThrow(ApiError);
    expect(() => validateMapping({
      schemaVersion: 1,
      columns: [
        { columnIndex: 0, target: 'name' },
        { columnIndex: 1, target: 'quantity' },
        { columnIndex: 2, target: 'compound_size' },
      ],
    }, signature)).not.toThrow();
  });

  it('requires a remembered header/data decision for geometry-only layouts', () => {
    const signature = canonicalSignature({
      fingerprintVersion: 1,
      parserMajor: 1,
      headerBandCount: 1,
      columns: [
        { header: 'column-1', relativeStart: 0, relativeEnd: 0.3 },
        { header: 'column-2', relativeStart: 0.3, relativeEnd: 0.6 },
        { header: 'column-3', relativeStart: 0.6, relativeEnd: 1 },
      ],
    });
    const columns = [
      { columnIndex: 0, target: 'name' as const },
      { columnIndex: 1, target: 'quantity' as const },
      { columnIndex: 2, target: 'compound_size' as const },
    ];
    expect(() => validateMapping({ schemaVersion: 1, columns }, signature)).toThrow(ApiError);
    expect(() => validateMapping({
      schemaVersion: 1,
      geometryCandidateRole: 'data',
      columns,
    }, signature)).not.toThrow();
  });

  it('matches an approved signature after a JSONB-style key reorder', async () => {
    const canonical = canonicalSignature(signature);
    const db = {
      query: async () => ({
        rows: [{
          bazis_pdf_table_pattern_id: 1,
          fingerprint: expect.any(String),
          fingerprint_version: 1,
          parser_major: 1,
          signature_json: {
            columns: canonical.columns.map(column => ({
              relativeEnd: column.relativeEnd,
              relativeStart: column.relativeStart,
              header: column.header,
            })),
            headerBandCount: canonical.headerBandCount,
            parserMajor: canonical.parserMajor,
            fingerprintVersion: canonical.fingerprintVersion,
          },
          mapping_json: { schemaVersion: 1, columns: [] },
          mapping_hash: 'x',
          approval_status: 'approved',
          is_active: true,
          version: 1,
        }],
      }),
    };
    // Capture the computed fingerprint and return it on the simulated DB row.
    const query = async (_sql: string, params: readonly unknown[]) => {
      const result = await db.query();
      result.rows[0].fingerprint = (params[0] as string[])[0];
      return result;
    };
    const service = new PdfTablePatternsService(
      { query } as never,
      { get: () => true } as never,
    );
    const response = await service.match({
      id: '1',
      username: 'manager',
      role: 'manager',
      roleId: 10,
      permissions: ['orders.import'],
    }, 'request-1', { signatures: [signature] });
    expect(response.results[0]).toMatchObject({
      status: 'exact',
      requiresConfirmation: false,
    });
  });

  it('learns a pending pattern atomically with idempotency, audit and outbox', async () => {
    vi.spyOn(auditService, 'record').mockResolvedValue('audit-1');
    const queries: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        queries.push(sql);
        if (sql.includes('INSERT INTO command_idempotency_keys')) {
          return { rowCount: 1, rows: [{ idempotency_key: params[0] }] };
        }
        if (sql.includes('SELECT * FROM bazis_pdf_table_patterns')
          && sql.includes('FOR UPDATE')) return { rowCount: 0, rows: [] };
        if (sql.includes('INSERT INTO bazis_pdf_table_patterns')) {
          return {
            rowCount: 1,
            rows: [{
              bazis_pdf_table_pattern_id: 7,
              fingerprint: params[0],
              fingerprint_version: 1,
              parser_major: 1,
              signature_json: JSON.parse(String(params[1])),
              mapping_json: JSON.parse(String(params[2])),
              mapping_hash: params[3],
              approval_status: params[4],
              is_active: true,
              version: 1,
            }],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
      raw: {},
    };
    const service = new PdfTablePatternsService(
      { transaction: (handler: (client: typeof tx) => unknown) => handler(tx) } as never,
      { get: () => true } as never,
    );
    const result = await service.learn(
      importer,
      'request-learn',
      'cb503f80-dc91-4d4c-8c53-f0ada50b7df2',
      { signature, mapping },
    );
    expect(result).toMatchObject({ id: 7, approvalStatus: 'pending', version: 1 });
    expect(auditService.record).toHaveBeenCalledOnce();
    expect(queries.some(sql => sql.includes('INSERT INTO outbox_events'))).toBe(true);
    expect(queries.some(sql => sql.includes("SET status='completed'"))).toBe(true);
  });

  it('updates and approves with optimistic version plus before/after audit', async () => {
    const audit = vi.spyOn(auditService, 'record').mockResolvedValue('audit-2');
    const canonical = canonicalSignature(signature);
    const current = {
      bazis_pdf_table_pattern_id: 8,
      fingerprint: 'a'.repeat(64),
      fingerprint_version: 1,
      parser_major: 1,
      signature_json: canonical,
      mapping_json: mapping,
      mapping_hash: 'old',
      approval_status: 'pending' as const,
      is_active: true,
      version: 1,
    };
    const tx = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO command_idempotency_keys')) {
          return { rowCount: 1, rows: [{ idempotency_key: 'claimed' }] };
        }
        if (sql.includes('SELECT * FROM bazis_pdf_table_patterns')) {
          return { rowCount: 1, rows: [current] };
        }
        if (sql.includes('UPDATE bazis_pdf_table_patterns SET')) {
          return {
            rowCount: 1,
            rows: [{ ...current, approval_status: 'approved' as const, version: 2 }],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
      raw: {},
    };
    const service = new PdfTablePatternsService(
      { transaction: (handler: (client: typeof tx) => unknown) => handler(tx) } as never,
      { get: () => true } as never,
    );
    const result = await service.update(
      manager,
      'request-update',
      current.fingerprint,
      '909b5467-d471-42c0-97be-8022317ba0d5',
      { version: 1, approvalStatus: 'approved' },
    );
    expect(result).toMatchObject({ approvalStatus: 'approved', version: 2 });
    expect(audit.mock.calls[0][1]).toMatchObject({
      before: { approvalStatus: 'pending', version: 1 },
      after: { approvalStatus: 'approved', version: 2 },
    });
  });

  it('fails closed when disabled and audits denied service access', async () => {
    const denied = vi.spyOn(auditService, 'recordDenied').mockResolvedValue('denied-1');
    const disabled = new PdfTablePatternsService({} as never, { get: () => false } as never);
    await expect(disabled.match(importer, 'request-disabled', { signatures: [signature] }))
      .rejects.toMatchObject({ code: 'FEATURE_DISABLED' });

    const deniedService = new PdfTablePatternsService(
      { query: vi.fn() } as never,
      { get: () => true } as never,
    );
    await expect(deniedService.match(
      { ...importer, permissions: [] },
      'request-denied',
      { signatures: [signature] },
    )).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(denied).toHaveBeenCalledOnce();
  });
});
