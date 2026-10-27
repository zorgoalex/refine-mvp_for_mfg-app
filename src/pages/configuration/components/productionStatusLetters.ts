import type { ProductionStatusRef } from '../../../types/productionWorkflow';

export interface LetterConflict {
  letter: string;
  codes: string[];
  names: string[];
}

// Active statuses that would show the same letter in orders and the calendar.
// codeToLetter is the effective letter (configured or the fallback from the name).
export const findLetterConflicts = (
  statuses: ProductionStatusRef[],
  codeToLetter: Record<string, string>,
): LetterConflict[] => {
  const byLetter = new Map<string, ProductionStatusRef[]>();
  statuses.forEach((status) => {
    if (!status.is_active) return;
    const letter = codeToLetter[status.production_status_code];
    if (!letter || letter === '?') return;
    byLetter.set(letter, [...(byLetter.get(letter) ?? []), status]);
  });
  return [...byLetter.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([letter, list]) => ({
      letter,
      codes: list.map((s) => s.production_status_code),
      names: list.map((s) => s.production_status_name),
    }));
};
