import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useTabStore } from '../stores/tabStore';
import { RESOURCE_LABELS, resourceFromPath } from './tabLabels';

type RecordLike = Record<string, unknown> | null | undefined;

const DEFAULT_TITLE_FIELDS = [
  'name',
  'title',
  'display_name',
  'full_name',
  'order_name',
  'client_name',
  'material_name',
  'film_name',
  'supplier_name',
  'vendor_name',
  'material_type_name',
  'unit_name',
  'type_name',
  'status_name',
  'employee_name',
  'username',
  'email',
];

const ACTION_LABELS: Record<string, string> = {
  show: 'Просмотр',
  edit: 'Редактирование',
};

const stringifyTitleValue = (value: unknown): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
};

const pickId = (record: RecordLike, fallbackId?: string | number): string | undefined => {
  const directFallback = stringifyTitleValue(fallbackId);
  if (record) {
    const idEntry = Object.entries(record).find(
      ([key, value]) => (key === 'id' || key.endsWith('_id')) && stringifyTitleValue(value)
    );
    const id = stringifyTitleValue(idEntry?.[1]);
    if (id) return `#${id}`;
  }
  return directFallback ? `#${directFallback}` : undefined;
};

export const pickRecordTitle = (
  record: RecordLike,
  fallbackId?: string | number,
  preferredFields: string[] = DEFAULT_TITLE_FIELDS
): string | undefined => {
  if (record) {
    for (const field of preferredFields) {
      const value = stringifyTitleValue(record[field]);
      if (value) return value;
    }
    for (const [field, rawValue] of Object.entries(record)) {
      if (!field.endsWith('_name')) continue;
      const value = stringifyTitleValue(rawValue);
      if (value) return value;
    }
  }
  return pickId(record, fallbackId);
};

export const buildRecordTabTitle = ({
  resourceLabel,
  actionLabel,
  record,
  fallbackId,
  preferredFields,
}: {
  resourceLabel: string;
  actionLabel: string;
  record: RecordLike;
  fallbackId?: string | number;
  preferredFields?: string[];
}): string => {
  const recordTitle = pickRecordTitle(record, fallbackId, preferredFields);
  return recordTitle ? `${resourceLabel} · ${actionLabel} · ${recordTitle}` : `${resourceLabel} · ${actionLabel}`;
};

export const useRecordTabTitle = ({
  resourceLabel,
  actionLabel,
  record,
  fallbackId,
  preferredFields,
  enabled = true,
}: {
  resourceLabel: string;
  actionLabel: string;
  record: RecordLike;
  fallbackId?: string | number;
  preferredFields?: string[];
  enabled?: boolean;
}): void => {
  const location = useLocation();
  const setTabTitle = useTabStore((s) => s.setTabTitle);
  const title = buildRecordTabTitle({ resourceLabel, actionLabel, record, fallbackId, preferredFields });

  useEffect(() => {
    if (!enabled) return;
    setTabTitle(location.pathname, title);
  }, [enabled, location.pathname, setTabTitle, title]);
};

export const useCurrentRecordTabTitle = (
  record: RecordLike,
  preferredFields?: string[]
): void => {
  const location = useLocation();
  const segs = location.pathname.split('/').filter(Boolean);
  const resource = resourceFromPath(location.pathname);
  const action = segs[1];
  const resourceLabel = resource ? RESOURCE_LABELS[resource] : undefined;
  const actionLabel = action ? ACTION_LABELS[action] : undefined;

  useRecordTabTitle({
    resourceLabel: resourceLabel ?? resource ?? segs[0] ?? '',
    actionLabel: actionLabel ?? action ?? '',
    record,
    fallbackId: segs[2],
    preferredFields,
    enabled: Boolean(resourceLabel && actionLabel),
  });
};
