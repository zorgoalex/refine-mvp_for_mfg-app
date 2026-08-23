import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MdfBoardHistoryOrderOptionDto } from '../dto/mdf-board-history.dto';
import {
  appendMdfHistoryOrderVisibilitySql,
  buildDiagnosis,
  type CurrentSource,
} from './pg-mdf-board-history-repository';

describe('MDF board current diagnosis', () => {
  it('applies canonical own/assigned order scope and hides deleted orders by default', () => {
    const managerParams: unknown[] = ['2711', 20];
    const managerPredicate = appendMdfHistoryOrderVisibilitySql(
      managerParams,
      currentUser('manager', ['orders.view']),
    );
    expect(managerParams).toEqual(['2711', 20, 7]);
    expect(managerPredicate).toContain('(o.created_by = $3 OR o.manager_id = $3)');
    expect(managerPredicate).toContain('COALESCE(o.delete_flag, false) = false');

    const workerParams: unknown[] = [2711];
    const workerPredicate = appendMdfHistoryOrderVisibilitySql(
      workerParams,
      currentUser('worker', ['orders.view']),
    );
    expect(workerParams).toEqual([2711, 7]);
    expect(workerPredicate).toContain('FROM order_workshops assigned_ow');
    expect(workerPredicate).toContain('assigned_user.user_id = $2');
  });

  it('allows deleted-order history only for an all-scope delete role', () => {
    const params: unknown[] = ['2711', 20];
    const predicate = appendMdfHistoryOrderVisibilitySql(
      params,
      currentUser('admin', ['orders.view', 'orders.delete']),
    );

    expect(params).toEqual(['2711', 20]);
    expect(predicate).toBe('(TRUE) AND (TRUE)');
  });

  it('loads history from the order creation date instead of a rolling window', () => {
    const source = readFileSync(new URL('./pg-mdf-board-history-repository.ts', import.meta.url), 'utf8');

    expect(source).toContain('o.created_at::date::text AS history_date_from');
    expect(source).not.toContain("CURRENT_DATE - INTERVAL '2 months'");
    expect(source).toContain("COALESCE(recorded.provenance, 'reconstructed') AS provenance");
  });

  it('explains why an ERP order has not appeared on the board', () => {
    const diagnosis = buildDiagnosis(order(), 'Новый', [], new Map());

    expect(diagnosis).toMatchObject({
      presence: 'not_on_board',
      currentColumn: null,
      automaticColumn: null,
      title: 'Заказ ещё не появился на МДФ-доске',
      blockers: [{ code: 'NO_MDF_SOURCES', count: 0 }],
    });
    expect(diagnosis.explanation).toContain('Создание заказа само по себе не создаёт карточку');
  });

  it('shows unfinished machine files and baths as causal blockers', () => {
    const sources: CurrentSource[] = [
      source('packet', 'packet-1', 'Файл станка №18', 'parsed', 6),
      source('bath', 'cut-result:9', 'Ванна 41', 'baths_ready', 4),
    ];

    const diagnosis = buildDiagnosis(order(), 'В производстве', sources, new Map());

    expect(diagnosis).toMatchObject({
      presence: 'on_board',
      currentColumn: 'orders',
      blockers: [
        { code: 'MACHINE_FILES_NOT_CUT', count: 6, relatedSubjectIds: ['packet-1'] },
        { code: 'BATHS_NOT_ROLLED', count: 4, relatedSubjectIds: ['cut-result:9'] },
      ],
    });
  });

  it('moves the order diagnosis to ready when every MDF source is complete', () => {
    const sources: CurrentSource[] = [
      source('packet', 'packet-1', 'Файл станка №18', 'completed', 6),
      source('bath', 'cut-result:9', 'Ванна 41', 'baths_laminated', 4),
    ];

    expect(buildDiagnosis(order(), 'В производстве', sources, new Map())).toMatchObject({
      presence: 'on_board',
      currentColumn: 'orders_ready',
      automaticColumn: 'orders_ready',
      blockers: [],
    });
  });
});

function order(): MdfBoardHistoryOrderOptionDto {
  return {
    orderId: 2711,
    orderName: '2711',
    fullNumber: 'МП-2711',
    deleted: false,
    createdAt: '2026-08-01T00:00:00.000Z',
  };
}

function currentUser(
  role: 'admin' | 'manager' | 'worker',
  permissions: Array<'orders.view' | 'orders.delete'>,
) {
  return { id: '7', username: role, role, roleId: 10, permissions };
}

function source(
  kind: CurrentSource['kind'],
  id: string,
  label: string,
  automaticColumn: CurrentSource['automaticColumn'],
  quantity: number,
): CurrentSource {
  return { kind, id, label, automaticColumn, currentColumn: automaticColumn, quantity };
}
