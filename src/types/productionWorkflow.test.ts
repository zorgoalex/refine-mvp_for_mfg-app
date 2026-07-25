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
        layout_rows: [['drawn', 'cut']],
      },
      statuses,
      'production.workflow.default',
    );

    expect(normalized.layout_rows).toEqual([['drawn', 'cut'], ['packed']]);
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
