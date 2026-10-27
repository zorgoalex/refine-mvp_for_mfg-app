// «NewLine» order card: the quick switch «По плёнке / По этапу / Списком» over the details (mockup 04).
// It sets the same grouping as the «Группировать по…» menu next to it; any other grouping chosen there
// leaves no segment selected.
import React from 'react';
import { Segmented } from '../../../../ui/Segmented';
import type { GroupField } from '../../detailGrouping';

export type WorkbenchGroupingKey = 'film' | 'production_status' | 'none';

export const WORKBENCH_GROUPING_OPTIONS: ReadonlyArray<{ value: WorkbenchGroupingKey; label: string }> = [
  { value: 'film', label: 'По плёнке' },
  { value: 'production_status', label: 'По этапу' },
  { value: 'none', label: 'Списком' },
];

export function workbenchGroupingKey(field: GroupField | null): WorkbenchGroupingKey | undefined {
  if (field === null) return 'none';
  if (field === 'film' || field === 'production_status') return field;
  return undefined;
}

export function groupFieldForWorkbenchKey(key: WorkbenchGroupingKey): GroupField | null {
  return key === 'none' ? null : key;
}

export const WorkbenchGroupingSwitch: React.FC<{
  field: GroupField | null;
  onFieldChange: (field: GroupField | null) => void;
}> = ({ field, onFieldChange }) => (
  <Segmented
    size="small"
    className="wb-grouping-switch"
    aria-label="Группировка деталей"
    options={WORKBENCH_GROUPING_OPTIONS.map((option) => ({ ...option }))}
    value={workbenchGroupingKey(field) as string}
    onChange={(value) => onFieldChange(groupFieldForWorkbenchKey(value as WorkbenchGroupingKey))}
  />
);
