import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { StaticCutConfig } from '../application/cut-config';
import type { FreecutClient } from './freecut-client';
import { PgCutRepository } from './pg-cut-repository';

const currentUser = { id: '1', username: 'Тест', role: 'manager', roleId: 1, permissions: ['cut.view'] } as unknown as CurrentUser;

function row(overrides: Record<string, unknown>) {
  return {
    cut_job_id: 1028, name: 'Тест раскрой', source_display_number: '411', is_vacuum: false,
    requires_recalc: false, current_order_name: '3123',
    order_detail_id: 1, snap_number: '1', snap_width: '596', snap_height: '700', snap_qty: '1', snap_sheet: '8',
    current_order_id: 11881, delete_flag: false, width: '596.000', height: '700.000', quantity: 1,
    detail_number: 1, sheet_material_type_id: 8,
    ...overrides,
  };
}

function repository(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  const database = { query } as unknown as DatabaseService;
  const repo = new PgCutRepository(database, { optimize: vi.fn() } as unknown as FreecutClient, new StaticCutConfig());
  return { repo, query };
}

describe('order cut issues', () => {
  it('reports deleted, moved and changed details per ready cut job of the order', async () => {
    const { repo, query } = repository([
      row({ order_detail_id: 1 }),
      row({ order_detail_id: 68666, snap_number: '3', delete_flag: true, detail_number: 3 }),
      row({ order_detail_id: 68667, snap_number: '4', current_order_id: 11999, current_order_name: '3065', detail_number: 9 }),
      row({ order_detail_id: 5, snap_number: '5', detail_number: 5, width: '600' }),
      row({ order_detail_id: 6, snap_number: '6', detail_number: 6, quantity: 2, sheet_material_type_id: 9 }),
      row({ order_detail_id: 7, snap_number: '7', current_order_id: null, delete_flag: null, width: null, height: null, quantity: null, detail_number: null }),
      row({ cut_job_id: 1030, source_display_number: null, is_vacuum: true, order_detail_id: 1 }),
      row({ cut_job_id: 1031, source_display_number: null, is_vacuum: true, requires_recalc: true, order_detail_id: 1 }),
    ]);

    const result = await repo.listOrderCutIssues({ currentUser, orderId: 11881 });

    expect(query.mock.calls[0][1]).toEqual([11881]);
    expect(result.jobs).toEqual([{
      cutJobId: 1028, cutNumber: '411', name: 'Тест раскрой', isVacuum: false, requiresRecalc: false,
      issues: [
        { kind: 'deleted', orderDetailId: 68666, detailNumber: 3, calculated: null, current: null },
        { kind: 'moved', orderDetailId: 68667, detailNumber: 4, calculated: null, current: '3065' },
        { kind: 'size_changed', orderDetailId: 5, detailNumber: 5, calculated: '700×596', current: '700×600' },
        { kind: 'quantity_changed', orderDetailId: 6, detailNumber: 6, calculated: '1', current: '2' },
        { kind: 'material_changed', orderDetailId: 6, detailNumber: 6, calculated: null, current: null },
        { kind: 'deleted', orderDetailId: 7, detailNumber: 7, calculated: null, current: null },
      ],
    }, {
      cutJobId: 1031, cutNumber: 'В-1031', name: 'Тест раскрой', isVacuum: true, requiresRecalc: true, issues: [],
    }]);
  });

  it('returns no jobs when every cut of the order matches its details', async () => {
    const { repo } = repository([row({}), row({ cut_job_id: 1030, order_detail_id: 2 })]);
    await expect(repo.listOrderCutIssues({ currentUser, orderId: 11881 })).resolves.toEqual({ jobs: [] });
  });
});

describe('order cut issues SQL', () => {
  it('selects jobs by the order recorded on items/placements and compares only ordinary details', async () => {
    const { repo, query } = repository([]);
    await repo.listOrderCutIssues({ currentUser, orderId: 11881 });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('SELECT cji.cut_job_id FROM cut_job_item cji WHERE cji.order_id = $1');
    expect(sql).toContain('SELECT p.cut_job_id FROM cut_result_placement p WHERE p.order_id = $1');
    expect(sql).not.toContain('od0.order_id = $1');
    expect(sql).toContain("AND COALESCE(item->>'sourceType', 'order_detail') = 'order_detail'");
  });
});
