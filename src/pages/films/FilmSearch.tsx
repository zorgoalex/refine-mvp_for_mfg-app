import { useList } from '@refinedev/core';
import { AutoComplete, Input } from 'antd';
import { useEffect, useState } from 'react';
import { buildFilmFilters, type FilmFilterValues } from './filmFilters';

interface FilmSearchProps {
  value: string;
  filters: FilmFilterValues;
  onChange: (value: string) => void;
  onSearch: (value: string) => void;
}

export function FilmSearch({ value, filters, onChange, onSearch }: FilmSearchProps) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const text = value.trim();

  useEffect(() => {
    const timer = setTimeout(() => setTerm(text), 200);
    return () => clearTimeout(timer);
  }, [text]);

  const { data, isFetching, isError } = useList<{ film_id: number; film_name: string }>({
    resource: 'films',
    filters: buildFilmFilters({ ...filters, film_name: term }),
    sorters: [{ field: 'film_name', order: 'asc' }, { field: 'film_id', order: 'asc' }],
    pagination: { current: 1, pageSize: 10 },
    queryOptions: { enabled: open && Boolean(text) && term === text, keepPreviousData: false },
  });

  // Hide previous results immediately while the next query is being prepared or loaded.
  const waiting = term !== text || isFetching;
  const names = [...new Set((data?.data ?? []).map((film) => film.film_name))];
  const options = waiting || isError || names.length === 0
    ? [{ value: text, disabled: true, label: waiting ? 'Поиск…'
      : isError ? 'Не удалось загрузить подсказки' : 'Совпадений нет' }]
    : names.map((name) => ({ value: name, label: name }));

  const submit = (nextValue: string) => {
    setOpen(false);
    onSearch(nextValue);
  };

  return (
    <AutoComplete
      value={value}
      options={options}
      open={open && Boolean(text)}
      filterOption={false}
      defaultActiveFirstOption={false}
      onDropdownVisibleChange={setOpen}
      onChange={(nextValue) => {
        onChange(nextValue);
        setOpen(Boolean(nextValue.trim()));
      }}
      onSelect={submit}
      style={{ width: 280, maxWidth: '100%' }}
    >
      <Input.Search
        aria-label="Поиск плёнок по названию"
        placeholder="Поиск по названию"
        allowClear
        onSearch={submit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // Native search inputs clear on Escape; here it only dismisses suggestions.
            event.preventDefault();
            setOpen(false);
          }
        }}
      />
    </AutoComplete>
  );
}
