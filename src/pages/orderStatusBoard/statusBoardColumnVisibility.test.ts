import { describe, expect, it } from 'vitest';
import {
  CNC_STATUS_BOARD_COLUMN_DEFINITIONS,
  STATUS_BOARD_COLUMN_PREFERENCE_KEYS,
  filterVisibleStatusBoardColumns,
} from './statusBoardColumnVisibility';

describe('status board column visibility', () => {
  it('uses an independent preference key for every board', () => {
    expect(new Set(Object.values(STATUS_BOARD_COLUMN_PREFERENCE_KEYS)).size).toBe(3);
    expect(STATUS_BOARD_COLUMN_PREFERENCE_KEYS).toEqual({
      order: 'statusBoardOrder',
      production: 'statusBoardProduction',
      cnc_today: 'statusBoardCnc',
    });
  });

  it('includes all five MDF board columns', () => {
    expect(CNC_STATUS_BOARD_COLUMN_DEFINITIONS.map(({ key }) => key)).toEqual([
      'parsed',
      'completed',
      'baths',
      'baths_ready',
      'orders',
    ]);
  });

  it('removes only columns hidden by the current user', () => {
    const columns = [{ key: 'new' }, { key: 'work' }, { key: 'done' }];

    expect(filterVisibleStatusBoardColumns(columns, ['work'])).toEqual([
      { key: 'new' },
      { key: 'done' },
    ]);
    expect(columns).toHaveLength(3);
  });
});
