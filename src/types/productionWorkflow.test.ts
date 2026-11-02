import { describe, expect, it } from 'vitest';
import {
  buildDefaultProductionWorkflowConfig,
  normalizeProductionWorkflowConfig,
  type ProductionStatusRef,
} from './productionWorkflow';

const statuses: ProductionStatusRef[] = [
  status(1, 'drawn'),
  status(2, 'cut'),
  status(3, 'packed'),
];

describe('production workflow visual layout', () => {
  it('starts with one stage on every visual row', () => {
    expect(
      buildDefaultProductionWorkflowConfig(statuses, 'production.workflow.default')
        .layout_rows,
    ).toEqual([['drawn'], ['cut'], ['packed']]);
  });

  it('preserves grouped visual rows without changing transitions', () => {
    const normalized = normalizeProductionWorkflowConfig(
      {
        ...buildDefaultProductionWorkflowConfig(
          statuses,
          'production.workflow.default',
        ),
        layout_rows: [['drawn', 'cut'], ['packed']],
        transitions_order: {
          drawn: ['packed'],
          cut: ['packed'],
        },
      },
      statuses,
      'production.workflow.default',
    );

    expect(normalized.layout_rows).toEqual([['drawn', 'cut'], ['packed']]);
    expect(normalized.transitions_order).toEqual({
      drawn: ['packed'],
      cut: ['packed'],
    });
  });

  it('adds newly introduced statuses as separate rows', () => {
    const normalized = normalizeProductionWorkflowConfig(
      {
        ...buildDefaultProductionWorkflowConfig(
          statuses,
          'production.workflow.default',
        ),
        status_codes_order: ['drawn', 'cut'],
        layout_rows: [['drawn', 'cut']],
      },
      statuses,
      'production.workflow.default',
    );

    expect(normalized.layout_rows).toEqual([['drawn', 'cut'], ['packed']]);
  });

  describe('«Базис» (saw) right after «Отрисован», whatever the stored order says', () => {
    const withSaw: ProductionStatusRef[] = [
      { ...status(16, 'new'), sort_order: 5 },
      { ...status(1, 'drawn'), sort_order: 10 },
      { ...status(32, 'saw'), sort_order: 10 },
      { ...status(9, 'film_purchase'), sort_order: 15 },
      { ...status(2, 'cut'), sort_order: 20 },
      { ...status(8, 'issued'), sort_order: 90 },
    ];
    const expectedOrder = ['new', 'drawn', 'saw', 'film_purchase', 'cut', 'issued'];
    const expectedRows = [['new'], ['drawn'], ['saw'], ['film_purchase', 'cut'], ['issued']];
    const normalize = (input: unknown) =>
      normalizeProductionWorkflowConfig(input, withSaw, 'production.workflow.default');

    it.each([
      ['absent', ['new', 'drawn', 'film_purchase', 'cut', 'issued'], [['new'], ['drawn'], ['film_purchase', 'cut'], ['issued']]],
      ['already in place', expectedOrder, expectedRows],
      ['saved at the end', ['new', 'drawn', 'film_purchase', 'cut', 'issued', 'saw'],
        [['new'], ['drawn'], ['film_purchase', 'cut'], ['issued'], ['saw']]],
      ['saved in the row of another stage', ['saw', 'new', 'drawn', 'film_purchase', 'cut', 'issued'],
        [['new'], ['drawn'], ['film_purchase', 'cut', 'saw'], ['issued']]],
    ])('%s', (_case, order, rows) => {
      const normalized = normalize({ status_codes_order: order, layout_rows: rows });
      expect(normalized.status_codes_order).toEqual(expectedOrder);
      expect(normalized.layout_rows).toEqual(expectedRows);
    });

    it('goes right after «Отрисован» even when the other stages were reordered by hand', () => {
      const normalized = normalize({ status_codes_order: ['drawn', 'cut', 'new', 'film_purchase', 'issued', 'saw'],
        layout_rows: [['drawn', 'cut'], ['new'], ['film_purchase'], ['issued'], ['saw']] });
      expect(normalized.status_codes_order).toEqual(['drawn', 'saw', 'cut', 'new', 'film_purchase', 'issued']);
      expect(normalized.layout_rows).toEqual([['drawn', 'cut'], ['saw'], ['new'], ['film_purchase'], ['issued']]);
      const reloaded = normalize(JSON.parse(JSON.stringify(normalized)));
      expect(reloaded.status_codes_order).toEqual(normalized.status_codes_order);
      expect(reloaded.layout_rows).toEqual(normalized.layout_rows);
    });

    it('is stable across save and reload (normalizing a normalized config changes nothing)', () => {
      const once = normalize({ status_codes_order: ['new', 'drawn', 'film_purchase', 'cut', 'issued', 'saw'],
        layout_rows: [['new'], ['drawn'], ['film_purchase', 'cut'], ['issued'], ['saw']] });
      const twice = normalize(JSON.parse(JSON.stringify(once)));
      expect(twice.status_codes_order).toEqual(once.status_codes_order);
      expect(twice.layout_rows).toEqual(once.layout_rows);
    });

    it('defaults without a stored config: by sort_order, then id', () => {
      expect(buildDefaultProductionWorkflowConfig([...withSaw].reverse(), 'production.workflow.default')
        .status_codes_order).toEqual(expectedOrder);
    });
  });

  it('drops malformed persisted rows and non-string stage codes', () => {
    const normalized = normalizeProductionWorkflowConfig(
      {
        ...buildDefaultProductionWorkflowConfig(
          statuses,
          'production.workflow.default',
        ),
        layout_rows: ['invalid', ['drawn', 42], [], ['cut']] as unknown as string[][],
      },
      statuses,
      'production.workflow.default',
    );

    expect(normalized.layout_rows).toEqual([['drawn'], ['cut'], ['packed']]);
  });
});

function status(
  production_status_id: number,
  production_status_code: string,
): ProductionStatusRef {
  return {
    production_status_id,
    production_status_code,
    production_status_name: production_status_code,
    sort_order: production_status_id,
    is_active: true,
  };
}
