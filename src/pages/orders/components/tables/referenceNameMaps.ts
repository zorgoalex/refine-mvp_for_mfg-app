import type React from 'react';

// Pure helpers for resolving reference labels in the order detail table without
// per-row network requests. Antd select options ({ value, label }) and the
// backend form-data maps both reduce to a Map<number, string>.

export interface ReferenceOption {
  value?: number | string | null;
  label?: React.ReactNode;
}

/** Build a numeric-keyed name map from antd select options. */
export function buildNameByIdMap(options?: ReferenceOption[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const option of options ?? []) {
    const value = option?.value;
    if (value === null || value === undefined) continue;
    const label = option?.label;
    map.set(Number(value), String(label ?? value));
  }
  return map;
}

/** Resolve a reference label from an id using an already-built name map. */
export function resolveReferenceLabel(
  id: number | null | undefined,
  namesById: Map<number, string>,
): string | undefined {
  if (id === null || id === undefined) return undefined;
  return namesById.get(Number(id));
}
