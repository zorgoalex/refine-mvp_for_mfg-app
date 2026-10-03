// «NewLine» cut screen, left panel head: title, «+ Задание», jobs kind, search and status chips.
// Presentation only — every control drives the state the page already has.
import React from 'react';
import { Badge, Button, Dropdown, Input } from 'antd';
import type { MenuProps } from 'antd';
import { FilterOutlined, MoreOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { Tooltip } from '../../ui/tooltipDelay';
import { Segmented } from '../../ui/Segmented';

export interface CutRailChip {
  value: string;
  label: string;
  count: number;
}

interface CutWorkbenchRailProps {
  title: string;
  /** «+ Задание»: opens the detail selection for a new cut */
  onCreate?: () => void;
  menuItems: MenuProps['items'];
  /** «Раскрои / Ванны» (absent in the order card tab) */
  kinds?: Array<{ value: string; label: string; count: number }>;
  kind?: string;
  onKindChange?: (value: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  chips: CutRailChip[];
  status: string;
  onStatusChange: (value: string) => void;
  activeFilterCount: number;
  onOpenFilters: () => void;
}

export const CutWorkbenchRail: React.FC<CutWorkbenchRailProps> = ({
  title,
  onCreate,
  menuItems,
  kinds,
  kind,
  onKindChange,
  search,
  onSearchChange,
  chips,
  status,
  onStatusChange,
  activeFilterCount,
  onOpenFilters,
}) => (
  <div className="wb-cut-rail">
    <div className="wb-cut-rail__head">
      <h2 className="wb-cut-rail__title">{title}</h2>
      {menuItems && menuItems.length > 0 ? (
        <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
          <Button type="text" icon={<MoreOutlined />} aria-label="Действия со списком заданий" />
        </Dropdown>
      ) : null}
      {onCreate ? (
        <Button type="primary" icon={<PlusOutlined />} onClick={onCreate} data-testid="cut-new-job">
          Задание
        </Button>
      ) : null}
    </div>
    {kinds && kinds.length > 0 ? (
      <Segmented
        block
        className="wb-cut-rail__kinds"
        value={kind}
        onChange={(value) => onKindChange?.(String(value))}
        options={kinds.map((item) => ({
          value: item.value,
          label: (
            <span className="wb-cut-rail__kind">
              {item.label}
              <small>{item.count}</small>
            </span>
          ),
        }))}
      />
    ) : null}
    <Input
      allowClear
      className="wb-cut-rail__search"
      prefix={<SearchOutlined />}
      placeholder="Номер, заказ или название"
      aria-label="Поиск задания"
      value={search}
      onChange={(event) => onSearchChange(event.target.value)}
    />
    <div className="wb-cut-rail__chips" role="group" aria-label="Статус заданий">
      {chips.map((chip) => (
        <button
          key={chip.value}
          type="button"
          className="wb-cut-rail__chip"
          aria-pressed={status === chip.value}
          onClick={() => onStatusChange(chip.value)}
        >
          {chip.label}
          <small>{chip.count}</small>
        </button>
      ))}
      <Tooltip title="Фильтры">
        <Badge count={activeFilterCount} size="small" offset={[-2, 2]}>
          <button
            type="button"
            className="wb-cut-rail__chip wb-cut-rail__chip--icon"
            aria-label="Фильтры заданий"
            onClick={onOpenFilters}
          >
            <FilterOutlined aria-hidden />
          </button>
        </Badge>
      </Tooltip>
    </div>
  </div>
);
