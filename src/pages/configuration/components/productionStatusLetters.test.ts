import { describe, expect, it } from 'vitest';
import { buildProductionStagesDisplayConfig } from '../../../utils/productionWorkflow';
import { findLetterConflicts } from './productionStatusLetters';

const statuses = [
  { production_status_id: 6, production_status_code: 'laminated', production_status_name: 'Закатан', sort_order: 70, is_active: true },
  { production_status_id: 8, production_status_code: 'issued', production_status_name: 'Выдан', sort_order: 90, is_active: true },
  { production_status_id: 22, production_status_code: 'zaversheno_x', production_status_name: 'Завершено', sort_order: 100, is_active: true },
];

const lettersFor = (letters: Record<string, string>) =>
  buildProductionStagesDisplayConfig({
    workflow: { letters_by_code: letters } as never,
    statuses,
    workflowKey: 'production.workflow.default',
  }).display.codeToLetter;

describe('findLetterConflicts', () => {
  it('reports the name fallback that repeats a configured letter', () => {
    expect(findLetterConflicts(statuses, lettersFor({ laminated: 'З' }))).toEqual([
      { letter: 'З', codes: ['laminated', 'zaversheno_x'], names: ['Закатан', 'Завершено'] },
    ]);
  });

  it('is empty once the letter is unique', () => {
    expect(findLetterConflicts(statuses, lettersFor({ laminated: 'З', zaversheno_x: 'Г' }))).toEqual([]);
  });

  it('ignores inactive statuses', () => {
    const inactive = statuses.map((s) => (s.production_status_id === 22 ? { ...s, is_active: false } : s));
    expect(findLetterConflicts(inactive, lettersFor({ laminated: 'З' }))).toEqual([]);
  });
});
