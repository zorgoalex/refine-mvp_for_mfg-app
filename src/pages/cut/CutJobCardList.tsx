// «NewLine»: cut jobs as cards instead of the 17-column table. Every value and action is
// produced by the SAME column renderers the table uses, so nothing the table offers is lost:
// the list only arranges those cells differently and adds the sorting the table headers had.
import React, { useMemo, useState } from 'react';
import { Select, Spin } from 'antd';
import type { ColumnsType, ColumnType } from 'antd/es/table';
import './cutJobCardList.css';

type SortOrder = 'ascend' | 'descend';

interface CutJobCardListProps<Row extends { cutJobId: number }> {
  jobs: readonly Row[];
  columns: ColumnsType<Row>;
  activeJobId?: number | null;
  loading?: boolean;
  emptyText: string;
  onOpen: (row: Row) => void;
}

const FACT_KEYS = ['positions', 'details', 'area', 'sheets', 'filmUsage'] as const;
const META_KEYS = ['orders', 'groups', 'profile', 'texture', 'detailMaterials'] as const;
const PLACED_KEYS = new Set<string>(['id', 'createdAt', 'name', 'status', 'source', 'mdfBoard', 'actions', ...FACT_KEYS, ...META_KEYS]);

// the table headers are written for narrow columns; a card has room for a plain word
const SHORT_LABELS: Record<string, string> = {
  positions: 'Позиции',
  details: 'Детали',
  area: 'Площадь',
  sheets: 'Листы',
  filmUsage: 'Плёнка',
  detailMaterials: 'Материал',
};

const INTERACTIVE_SELECTOR = 'a, button, input, label, [role="button"], .ant-select, .ant-dropdown, .ant-popover';

const columnTitle = (column: ColumnType<any> | undefined): React.ReactNode => {
  const short = SHORT_LABELS[String(column?.key)];
  if (short) return short;
  return typeof column?.title === 'function' ? null : column?.title as React.ReactNode;
};

export function CutJobCardList<Row extends { cutJobId: number }>({
  jobs,
  columns,
  activeJobId,
  loading = false,
  emptyText,
  onOpen,
}: CutJobCardListProps<Row>) {
  const [sort, setSort] = useState<string>('default');
  const byKey = useMemo(
    () => new Map((columns as ColumnType<Row>[]).map((column) => [String(column.key), column])),
    [columns],
  );
  const sortable = useMemo(
    () => (columns as ColumnType<Row>[]).filter((column) => typeof column.sorter === 'function'),
    [columns],
  );
  const sortOptions = useMemo(() => [
    { value: 'default', label: 'Как в списке' },
    ...sortable.flatMap((column) => {
      const title = typeof column.title === 'string' ? column.title : String(column.key);
      return [
        { value: `${String(column.key)}:descend`, label: `${title} ↓` },
        { value: `${String(column.key)}:ascend`, label: `${title} ↑` },
      ];
    }),
  ], [sortable]);
  const sortedJobs = useMemo(() => {
    if (sort === 'default') return jobs;
    const [key, order] = sort.split(':') as [string, SortOrder];
    const sorter = byKey.get(key)?.sorter;
    if (typeof sorter !== 'function') return jobs;
    const sorted = [...jobs].sort((left, right) => sorter(left, right, order));
    return order === 'descend' ? sorted.reverse() : sorted;
  }, [byKey, jobs, sort]);
  // a column added to the table later is still shown, under its own title
  const extraKeys = useMemo(
    () => [...byKey.keys()].filter((key) => !PLACED_KEYS.has(key)),
    [byKey],
  );

  const cell = (key: string, row: Row, index: number): React.ReactNode => {
    const column = byKey.get(key);
    if (!column) return null;
    const value = typeof column.dataIndex === 'string' ? (row as Record<string, unknown>)[column.dataIndex] : undefined;
    const rendered = column.render ? column.render(value, row, index) : value;
    return rendered as React.ReactNode;
  };
  const labelled = (key: string, row: Row, index: number) => {
    const content = cell(key, row, index);
    if (content === null || content === undefined || content === false || content === '') return null;
    return (
      <span className="wb-cut-job__pair" key={key}>
        <span className="wb-cut-job__label">{columnTitle(byKey.get(key))}</span>
        <span className="wb-cut-job__value">{content}</span>
      </span>
    );
  };

  if (loading && jobs.length === 0) {
    return <div className="wb-cut-jobs wb-cut-jobs--state"><Spin /></div>;
  }
  if (jobs.length === 0) {
    return <div className="wb-cut-jobs wb-cut-jobs--state">{emptyText}</div>;
  }

  return (
    <div className="wb-cut-jobs" aria-busy={loading}>
      {sortOptions.length > 1 ? (
        <div className="wb-cut-jobs__toolbar">
          <span className="wb-cut-jobs__count">Заданий: {jobs.length}</span>
          <Select<string>
            aria-label="Сортировка заданий"
            size="small"
            value={sort}
            onChange={setSort}
            options={sortOptions}
            style={{ width: 190 }}
          />
        </div>
      ) : null}
      <div className="wb-cut-jobs__grid">
        {sortedJobs.map((row, index) => (
          <article
            key={row.cutJobId}
            className="wb-cut-job"
            data-active={row.cutJobId === activeJobId}
            data-testid="cut-job-card"
            onClick={(event) => {
              // buttons, links and menus inside the card keep their own action
              if ((event.target as HTMLElement).closest?.(INTERACTIVE_SELECTOR)) return;
              onOpen(row);
            }}
          >
            <header className="wb-cut-job__head">
              <span className="wb-cut-job__number">{cell('id', row, index)}</span>
              <span className="wb-cut-job__source">{cell('source', row, index)}</span>
              <span className="wb-cut-job__status">{cell('status', row, index)}</span>
              <span className="wb-cut-job__date">{cell('createdAt', row, index)}</span>
            </header>
            <div className="wb-cut-job__name">{cell('name', row, index)}</div>
            <div className="wb-cut-job__facts">
              {FACT_KEYS.map((key) => labelled(key, row, index))}
            </div>
            <div className="wb-cut-job__meta">
              {[...META_KEYS, ...extraKeys].map((key) => labelled(key, row, index))}
            </div>
            {byKey.has('mdfBoard') ? (
              <div className="wb-cut-job__mdf">
                <span className="wb-cut-job__label">{columnTitle(byKey.get('mdfBoard'))}</span>
                {cell('mdfBoard', row, index)}
              </div>
            ) : null}
            <footer className="wb-cut-job__actions">{cell('actions', row, index)}</footer>
          </article>
        ))}
      </div>
    </div>
  );
}
