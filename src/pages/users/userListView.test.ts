import { describe, expect, it } from 'vitest';
import { userActiveFilterChoice, userInitials, userSearchText } from './userListView';

describe('users list view (NewLine)', () => {
  it('reads the activity choice from table filters in any shape', () => {
    expect(userActiveFilterChoice(undefined)).toBe('all');
    expect(userActiveFilterChoice([{ field: 'is_active', operator: 'eq', value: true }])).toBe('active');
    expect(userActiveFilterChoice([{ field: 'is_active', operator: 'eq', value: 'false' }])).toBe('inactive');
    expect(userActiveFilterChoice([{ field: 'is_active', operator: 'in', value: [false] }])).toBe('inactive');
    expect(userActiveFilterChoice([{ field: 'is_active', operator: 'in', value: [true, false] }])).toBe('all');
    expect(userActiveFilterChoice([{ field: 'is_active', operator: 'eq', value: undefined }])).toBe('all');
  });

  it('reads the search text', () => {
    expect(userSearchText([{ field: 'username', operator: 'contains', value: ' ivan ' }])).toBe('ivan');
    expect(userSearchText([{ field: 'email', value: 'x' }])).toBe('');
  });

  it('builds initials from up to two words', () => {
    expect(userInitials('Иван Петров Сидорович')).toBe('ИП');
    expect(userInitials('admin')).toBe('A');
    expect(userInitials('  ')).toBe('');
  });
});
