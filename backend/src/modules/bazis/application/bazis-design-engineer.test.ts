import { describe, expect, it } from 'vitest';
import { matchBazisDesignEngineer } from './bazis-design-engineer';

const employees = [
  { employeeId: 10, fullName: 'Тапен Жамит' },
  { employeeId: 11, fullName: 'Иванов Иван Иванович' },
];

describe('matchBazisDesignEngineer', () => {
  it('prefers an exact normalized full-name match', () => {
    expect(matchBazisDesignEngineer('иванов иван иванович', employees)?.employeeId).toBe(11);
  });

  it('matches Bazis surname and initials to one employee', () => {
    expect(matchBazisDesignEngineer('Тапен Ж.К', employees)?.employeeId).toBe(10);
  });

  it('does not choose an ambiguous or surname-only employee', () => {
    expect(
      matchBazisDesignEngineer('Тапен Ж.', [...employees, { employeeId: 12, fullName: 'Тапен Жанат' }]),
    ).toBeNull();
    expect(matchBazisDesignEngineer('Тапен', employees)).toBeNull();
  });
});
