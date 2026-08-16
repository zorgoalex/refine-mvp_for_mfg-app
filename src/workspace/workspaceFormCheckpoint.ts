import dayjs from 'dayjs';
import type { FormInstance } from 'antd';
import type {
  WorkspaceSerializable,
  WorkspaceSerializableRecord,
} from './workspaceUiStateStore';

interface SerializedAntFormCheckpoint extends WorkspaceSerializableRecord {
  values: WorkspaceSerializable;
  fields: WorkspaceSerializable[];
}

export function captureAntFormCheckpoint(form: FormInstance): SerializedAntFormCheckpoint {
  const fields = form.getFieldsError().map((field) => ({
    name: field.name.map((segment) => typeof segment === 'number' ? segment : String(segment)),
    touched: form.isFieldTouched(field.name),
    errors: [...field.errors],
    warnings: [...field.warnings],
  }));
  return {
    values: serializeFormValue(form.getFieldsValue(true)),
    fields,
  };
}

export function restoreAntFormCheckpoint(
  form: FormInstance,
  checkpoint: unknown,
): boolean {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return false;
  const record = checkpoint as WorkspaceSerializableRecord;
  if (!('values' in record) || !Array.isArray(record.fields)) return false;
  const values = deserializeFormValue(record.values);
  form.setFieldsValue(values);
  form.setFields(record.fields.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const name = Array.isArray(entry.name)
      ? entry.name.filter((segment): segment is string | number => (
          typeof segment === 'string' || typeof segment === 'number'
        ))
      : [];
    if (name.length === 0) return [];
    return [{
      name,
      touched: entry.touched === true,
      errors: Array.isArray(entry.errors) ? entry.errors.map(String) : [],
      warnings: Array.isArray(entry.warnings) ? entry.warnings.map(String) : [],
    }];
  }));
  return true;
}

function serializeFormValue(value: unknown): WorkspaceSerializable {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (dayjs.isDayjs(value)) return { __workspaceType: 'dayjs', value: value.toISOString() };
  if (value instanceof Date) return { __workspaceType: 'date', value: value.toISOString() };
  if (Array.isArray(value)) return value.map(serializeFormValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, serializeFormValue(nested)]));
  }
  return String(value);
}

function deserializeFormValue(value: WorkspaceSerializable | undefined): unknown {
  if (Array.isArray(value)) return value.map(deserializeFormValue);
  if (value && typeof value === 'object') {
    if (value.__workspaceType === 'dayjs' && typeof value.value === 'string') return dayjs(value.value);
    if (value.__workspaceType === 'date' && typeof value.value === 'string') return new Date(value.value);
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, deserializeFormValue(nested)]));
  }
  return value;
}
