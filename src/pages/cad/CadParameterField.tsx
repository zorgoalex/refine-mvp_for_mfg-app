import React, { useEffect, useState } from 'react';
import { Checkbox, Input, Select } from 'antd';
import type { CadCatalog, CadParameter } from '@shared/cad-api';
import type { JsonValue } from '@shared/cad-workspace';

interface Props { name: string; schema: CadParameter; value: JsonValue; disabled: boolean; bounded: boolean;
  tools: CadCatalog['recipes'][number]['available_tools']; onChange: (value: JsonValue) => void;
  onValidity: (name: string, valid: boolean) => void; onFocus: (name: string) => void }
export function CadParameterField({ name, schema, value, disabled, bounded, tools, onChange, onValidity, onFocus }: Props) {
  const format = (v: JsonValue) => typeof v === 'string' ? v : v === null ? '' : JSON.stringify(v);
  const [text, setText] = useState(format(value)); const [error, setError] = useState('');
  useEffect(() => { setText(format(value)); setError(''); onValidity(name, true); }, [value]);
  const label = `${schema.label ?? name}${schema.unit ? `, ${schema.unit}` : ''}`;
  const accept = (raw: string) => {
    setText(raw);
    try {
      let next: JsonValue = raw;
      if (schema.type === 'number') {
        if (!raw.trim() && schema.nullable) next = null;
        else {
          if (!/^[-+]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(raw.trim())) throw new Error('Введите число');
          next = Number(raw.replace(',', '.'));
          if (!Number.isFinite(next) || schema.integer && !Number.isInteger(next)) throw new Error(schema.integer ? 'Введите целое число' : 'Введите конечное число');
          if (bounded && (schema.min != null && next < schema.min || schema.max != null && next > schema.max)) throw new Error(`Допустимо от ${schema.min} до ${schema.max}`);
        }
      } else if (schema.type === 'array' || schema.type === 'object') next = JSON.parse(raw);
      setError(''); onValidity(name, true); onChange(next);
    } catch (e) { setError(e instanceof Error ? e.message : 'Проверьте значение'); onValidity(name, false); }
  };
  const options = schema.choices?.map(v => ({ value: JSON.stringify(v), label: String(v) }));
  const isTool = name.endsWith('tool_id') || name === 'tool_id';
  return <div className="cad-parameter" onFocus={() => onFocus(name)}>
    <label htmlFor={`cad-param-${name}`}>{label}</label>
    {schema.type === 'boolean' ? <Checkbox id={`cad-param-${name}`} disabled={disabled} checked={value === true} onChange={e => onChange(e.target.checked)}>Включено</Checkbox>
      : isTool ? <Select popupClassName="cad-compact" id={`cad-param-${name}`} aria-label={label} disabled={disabled} value={typeof value === 'string' ? value : undefined} options={tools.map(t => ({ value: t.id, label: t.display_name }))} onChange={onChange} />
        : options ? <Select popupClassName="cad-compact" id={`cad-param-${name}`} aria-label={label} disabled={disabled} value={JSON.stringify(value)} options={options} onChange={v => onChange(JSON.parse(v))} />
          : <Input id={`cad-param-${name}`} aria-label={label} aria-invalid={Boolean(error)} aria-describedby={error ? `cad-error-${name}` : undefined} inputMode={schema.type === 'number' ? 'decimal' : undefined} disabled={disabled} value={text} status={error ? 'error' : undefined} onChange={e => accept(e.target.value)} />}
    {error && <small role="alert" id={`cad-error-${name}`}>{error}</small>}
    {bounded && schema.min != null && <small className="cad-hint">От {schema.min} до {schema.max} {schema.unit}</small>}
  </div>;
}
