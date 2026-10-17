import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyFeatureFlags, featureFlags } from '../../config/featureFlags';
import { canMutateHasuraResource, BACKEND_OWNED_HASURA_WRITES } from '../../utils/resourcePermissions';
import { buildUpdateDowelingRequest } from '../../api/dowelingApi';

const SRC = join(__dirname, '..', '..');
// The legacy order save (useBackendOrdersWrite=false) is a rollback path that still names the tables; its Hasura writes
// are refused by the data provider (BACKEND_OWNED_HASURA_WRITES) and by Hasura.
const LEGACY_ALLOWED = new Set(['hooks/useOrderSave.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const TABLE = `['"](?:doweling_orders|order_doweling_links)['"]`;
const WRITE_PATTERNS = [
  // Refine mutations and the data provider called with one of the tables.
  new RegExp(`\\b(?:mutate|mutateAsync|create|update|deleteOne|deleteMany|createMany|updateMany)\\w*\\(\\s*\\{\\s*resource:\\s*${TABLE}`),
  // A Refine form bound to a table writes it on submit.
  new RegExp(`\\buseForm\\w*\\(\\s*\\{\\s*resource:\\s*${TABLE}`),
];

describe('doweling writes are backend commands (no page-level Hasura writes)', () => {
  it('no source file writes doweling_orders / order_doweling_links through Refine or the data provider', () => {
    const offenders = sourceFiles(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => !LEGACY_ALLOWED.has(path))
      .filter((path) => WRITE_PATTERNS.some((pattern) => pattern.test(readFileSync(join(SRC, path), 'utf8'))));
    expect(offenders).toEqual([]);
  });

  const originalFlags = { ...featureFlags };
  afterEach(() => applyFeatureFlags(originalFlags));

  it('the data provider refuses Hasura writes of these resources for every user, even a superadmin', () => {
    applyFeatureFlags({ ...featureFlags, useBackendAuth: false, useBackendPermissions: true });
    expect([...BACKEND_OWNED_HASURA_WRITES].sort()).toEqual(['doweling_orders', 'order_doweling_links']);
    const superadmin = { role: 'superadmin', permissions: ['doweling.view', 'doweling.create', 'doweling.update', 'doweling.delete', 'orders.view'] };
    for (const resource of BACKEND_OWNED_HASURA_WRITES) {
      for (const op of ['insert', 'update', 'delete'] as const) {
        expect(canMutateHasuraResource(resource, superadmin, op), `${resource}/${op}`).toBe(false);
      }
    }
  });
});

describe('doweling card → PATCH /doweling-orders/:id', () => {
  const values = {
    doweling_order_name: '  Присадка  ',
    doweling_order_date: '2026-10-15',
    payment_status_id: '1',
    production_status_id: null,
    design_engineer_id: 3,
    operator_id: '',
    issue_date: null,
    payment_date: null,
    parts_count: '12',
    total_amount: 1000,
    final_amount: 950,
    discount: 50,
    surcharge: null,
    paid_amount: undefined,
    link_cad_file: '  ',
    link_pdf_file: 'https://example.test/a.pdf',
    ref_key_1c: '',
    is_active: true,
    order_ids: ['101', 102, 102],
  };

  it('sends the full card with the loaded version and every linked order once', () => {
    expect(buildUpdateDowelingRequest(values, { expectedVersion: 4, fallbackDate: '2026-01-01', baseOrderIds: [102, 101, 101] })).toEqual({
      expectedVersion: 4,
      dowelingOrderName: 'Присадка',
      dowelingOrderDate: '2026-10-15',
      paymentStatusId: 1,
      designEngineerId: 3,
      productionStatusId: null,
      operatorId: null,
      issueDate: null,
      paymentDate: null,
      partsCount: 12,
      totalAmount: 1000,
      finalAmount: 950,
      discount: 50,
      surcharge: 0,
      paidAmount: 0,
      linkCadFile: null,
      linkPdfFile: 'https://example.test/a.pdf',
      refKey1c: null,
      isActive: true,
      orderIds: [101, 102],
      baseOrderIds: [101, 102],
    });
  });

  it('an inactive doweling order is linked to no order; a missing date falls back to the stored one', () => {
    const request = buildUpdateDowelingRequest({ ...values, is_active: false, doweling_order_date: null }, { expectedVersion: 0, fallbackDate: '2026-01-01', baseOrderIds: [] });
    expect(request).toMatchObject({ isActive: false, orderIds: [], dowelingOrderDate: '2026-01-01' });
  });
});
