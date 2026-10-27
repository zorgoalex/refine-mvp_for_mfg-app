import { describe, expect, it } from 'vitest';
import { groupFieldForWorkbenchKey, workbenchGroupingKey } from './WorkbenchGroupingSwitch';

describe('WorkbenchGroupingSwitch', () => {
  it('maps the grouping field to a segment', () => {
    expect(workbenchGroupingKey('film')).toBe('film');
    expect(workbenchGroupingKey('production_status')).toBe('production_status');
    expect(workbenchGroupingKey(null)).toBe('none');
  });

  it('leaves no segment for a grouping chosen in the full menu', () => {
    expect(workbenchGroupingKey('material')).toBeUndefined();
  });

  it('maps a segment back to the grouping field', () => {
    expect(groupFieldForWorkbenchKey('film')).toBe('film');
    expect(groupFieldForWorkbenchKey('production_status')).toBe('production_status');
    expect(groupFieldForWorkbenchKey('none')).toBeNull();
  });
});
