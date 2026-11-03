// Filters of a reference list: search and «Показывать неактивные» always visible, the screen's own
// fields in the «Фильтры» spoiler (collapsed by default, the choice is remembered per screen), and
// «Сбросить» next to them — it resets everything without opening the spoiler.
import React, { useEffect, useRef, useState } from 'react';
import { Badge, Button, Checkbox, Input, InputNumber, Select } from 'antd';
import { ClearOutlined, DownOutlined, FilterOutlined, SearchOutlined } from '@ant-design/icons';
import { useSelect } from '@refinedev/antd';
import {
  activeSpoilerCount,
  boolFromFilter,
  filterValue,
  hasUserFilters,
  showsInactive,
  withField,
  withShowInactive,
  type RefineFilter,
  type ReferenceFilterConfig,
  type ReferenceFilterField,
} from './referenceFilterModel';
import './referenceFilters.css';

type SetFilters = (filters: any[], behavior?: 'merge' | 'replace') => void;

export interface ReferenceFilterBarProps {
  /** Key of the remembered spoiler state. */
  storageKey: string;
  config: ReferenceFilterConfig;
  filters: readonly RefineFilter[] | undefined;
  setFilters: SetFilters;
  setCurrent?: (page: number) => void;
}

const SPOILER_PREFIX = 'erp.referenceFilters.open.';

function readOpen(storageKey: string): boolean {
  try {
    return window.localStorage.getItem(SPOILER_PREFIX + storageKey) === '1';
  } catch {
    return false;
  }
}

/**
 * Text typed in a field is applied after a short pause or on Enter. A reset (`generation` changes) drops what was
 * typed and the pending apply, so the cleared filters do not come back.
 */
function useDebouncedText(applied: string, apply: (value: string) => void, generation: number) {
  const [text, setText] = useState(applied);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setText(applied), [applied]);
  const seenGeneration = useRef(generation);
  useEffect(() => {
    if (seenGeneration.current === generation) return;
    seenGeneration.current = generation;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setText('');
  }, [generation]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const change = (value: string) => {
    setText(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => apply(value.trim()), 500);
  };
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    apply(text.trim());
  };
  return { text, change, flush };
}

const TextField: React.FC<{ field: Extract<ReferenceFilterField, { kind: 'text' }>; value: string; generation: number; onApply: (value: string) => void }> = ({ field, value, generation, onApply }) => {
  const input = useDebouncedText(value, onApply, generation);
  return (
    <Input
      allowClear
      size="small"
      aria-label={field.label}
      placeholder={field.placeholder ?? field.label}
      value={input.text}
      onChange={(event) => input.change(event.target.value)}
      onPressEnter={input.flush}
    />
  );
};

const ResourceSelectField: React.FC<{
  field: Extract<ReferenceFilterField, { kind: 'select' }>;
  value: unknown;
  onApply: (value: unknown) => void;
}> = ({ field, value, onApply }) => {
  const { selectProps } = useSelect({
    resource: field.resource as string,
    optionLabel: field.optionLabel as any,
    optionValue: field.optionValue as any,
    pagination: { pageSize: 200 },
  });
  return (
    <Select
      {...selectProps}
      allowClear
      showSearch
      size="small"
      aria-label={field.label}
      placeholder={field.label}
      value={value === undefined || value === '' ? undefined : (Number.isFinite(Number(value)) ? Number(value) : value) as any}
      onChange={(next) => onApply(next ?? undefined)}
      onSearch={selectProps.onSearch}
      filterOption={false}
    />
  );
};

const RangeField: React.FC<{ field: Extract<ReferenceFilterField, { kind: 'range' }>; from: unknown; to: unknown; onApply: (from: unknown, to: unknown) => void }> = ({ field, from, to, onApply }) => (
  <span className="ref-filters__range">
    <InputNumber size="small" aria-label={`${field.label}: от`} placeholder="от" value={from === undefined ? null : Number(from)} onChange={(next) => onApply(next ?? undefined, to)} />
    <span aria-hidden>—</span>
    <InputNumber size="small" aria-label={`${field.label}: до`} placeholder="до" value={to === undefined ? null : Number(to)} onChange={(next) => onApply(from, next ?? undefined)} />
  </span>
);

export const ReferenceFilterBar: React.FC<ReferenceFilterBarProps> = ({ storageKey, config, filters, setFilters, setCurrent }) => {
  const current = (filters ?? []) as RefineFilter[];
  const [open, setOpen] = useState(() => readOpen(storageKey));
  // Every change is made on top of the latest filters (also right after a change, before Refine re-renders):
  // a delayed search must not undo a checkbox or a select chosen in the meantime.
  const latest = useRef<RefineFilter[]>(current);
  const seenFilters = useRef(filters);
  if (seenFilters.current !== filters) {
    seenFilters.current = filters;
    latest.current = current;
  }
  const apply = (next: RefineFilter[]) => {
    latest.current = next;
    setFilters(next as any[], 'replace');
    setCurrent?.(1);
  };
  const update = (change: (filters: RefineFilter[]) => RefineFilter[]) => apply(change(latest.current));
  const [generation, setGeneration] = useState(0);
  const reset = () => {
    setGeneration((value) => value + 1);
    apply([]);
  };
  const toggleOpen = () => {
    setOpen((value) => {
      try { window.localStorage.setItem(SPOILER_PREFIX + storageKey, value ? '0' : '1'); } catch { /* only for this load */ }
      return !value;
    });
  };

  const searchField = config.search?.field;
  const search = useDebouncedText(
    searchField ? String(filterValue(current, searchField, 'contains') ?? '') : '',
    (value) => { if (searchField) update((filters) => withField(filters, searchField, [{ operator: 'contains', value }])); },
    generation,
  );
  const spoilerCount = activeSpoilerCount(current, config);
  const anyFilter = hasUserFilters(current);

  return (
    <div className="ref-filters">
      <div className="ref-filters__bar">
        {config.search ? (
          <Input
            className="ref-filters__search"
            allowClear
            prefix={<SearchOutlined />}
            aria-label={config.search.placeholder}
            placeholder={config.search.placeholder}
            value={search.text}
            onChange={(event) => search.change(event.target.value)}
            onPressEnter={search.flush}
          />
        ) : null}
        {config.activeField ? (
          <Checkbox checked={showsInactive(current)} onChange={(event) => { const show = event.target.checked; update((filters) => withShowInactive(filters, show)); }}>
            Показывать неактивные
          </Checkbox>
        ) : null}
        {config.fields.length > 0 ? (
          <Button
            className="ref-filters__toggle"
            icon={<FilterOutlined />}
            aria-expanded={open}
            onClick={toggleOpen}
            type={spoilerCount > 0 ? 'primary' : 'default'}
            ghost={spoilerCount > 0}
          >
            Фильтры
            {spoilerCount > 0 ? <Badge count={spoilerCount} size="small" className="ref-filters__count" /> : null}
            <DownOutlined className="ref-filters__chevron" data-open={open || undefined} />
          </Button>
        ) : null}
        {anyFilter ? (
          <Button className="ref-filters__reset" icon={<ClearOutlined />} onClick={reset}>
            Сбросить
          </Button>
        ) : null}
      </div>
      {open && config.fields.length > 0 ? (
        <div className="ref-filters__panel" role="group" aria-label="Фильтры справочника">
          {config.fields.map((field) => (
            <div key={field.field} className="ref-filters__field">
              <span className="ref-filters__label">{field.label}</span>
              {field.kind === 'text' ? (
                <TextField
                  field={field}
                  value={String(filterValue(current, field.field, 'contains') ?? '')}
                  generation={generation}
                  onApply={(value) => update((filters) => withField(filters, field.field, [{ operator: 'contains', value }]))}
                />
              ) : field.kind === 'select' && field.resource ? (
                <ResourceSelectField
                  field={field}
                  value={filterValue(current, field.field, 'eq')}
                  onApply={(value) => update((filters) => withField(filters, field.field, [{ operator: 'eq', value }]))}
                />
              ) : field.kind === 'select' ? (
                <Select
                  allowClear
                  size="small"
                  aria-label={field.label}
                  placeholder={field.label}
                  options={(field.options ?? []).map((option) => ({ ...option }))}
                  value={filterValue(current, field.field, 'eq') as any}
                  onChange={(value) => update((filters) => withField(filters, field.field, [{ operator: 'eq', value }]))}
                />
              ) : field.kind === 'boolean' ? (
                <Select
                  allowClear
                  size="small"
                  aria-label={field.label}
                  placeholder="Все"
                  options={[{ value: 'true', label: field.yes ?? 'Да' }, { value: 'false', label: field.no ?? 'Нет' }]}
                  value={(() => { const value = boolFromFilter(filterValue(current, field.field, 'eq')); return value === undefined ? undefined : String(value); })()}
                  onChange={(value) => update((filters) => withField(filters, field.field, [{ operator: 'eq', value: value === undefined ? undefined : value === 'true' }]))}
                />
              ) : (
                <RangeField
                  field={field}
                  from={filterValue(current, field.field, 'gte')}
                  to={filterValue(current, field.field, 'lte')}
                  onApply={(from, to) => update((filters) => withField(filters, field.field, [{ operator: 'gte', value: from }, { operator: 'lte', value: to }]))}
                />
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
