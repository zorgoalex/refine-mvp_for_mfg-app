import React from 'react';
import AntdPopover, { type PopoverProps as AntdPopoverProps } from 'antd/es/popover';
import AntdTable, { type TableProps as AntdTableProps } from 'antd/es/table';
import AntdTooltip, { type TooltipProps as AntdTooltipProps } from 'antd/es/tooltip';

export type { PopoverProps } from 'antd/es/popover';
export type { TablePaginationConfig, TableProps } from 'antd/es/table';
export type { TooltipProps } from 'antd/es/tooltip';

export const APP_TOOLTIP_MOUSE_ENTER_DELAY_SECONDS = 2.0;

function withMinimumTooltipDelay(delay: number | undefined): number {
  return Math.max(delay ?? APP_TOOLTIP_MOUSE_ENTER_DELAY_SECONDS, APP_TOOLTIP_MOUSE_ENTER_DELAY_SECONDS);
}

const DelayedTooltip = React.forwardRef<unknown, AntdTooltipProps>((props, ref) => {
  const { mouseEnterDelay, ...rest } = props;
  return (
    <AntdTooltip
      {...rest}
      ref={ref}
      mouseEnterDelay={withMinimumTooltipDelay(mouseEnterDelay)}
    />
  );
});

Object.assign(DelayedTooltip, AntdTooltip);
DelayedTooltip.displayName = 'Tooltip';

export const Tooltip = DelayedTooltip as typeof AntdTooltip;

const DelayedPopover = React.forwardRef<unknown, AntdPopoverProps>((props, ref) => {
  const { mouseEnterDelay, ...rest } = props;
  return (
    <AntdPopover
      {...rest}
      ref={ref}
      mouseEnterDelay={withMinimumTooltipDelay(mouseEnterDelay)}
    />
  );
});

Object.assign(DelayedPopover, AntdPopover);
DelayedPopover.displayName = 'Popover';

export const Popover = DelayedPopover as typeof AntdPopover;

function withDelayedSorterTooltip(showSorterTooltip: AntdTableProps<any>['showSorterTooltip']) {
  if (showSorterTooltip === false) return false;
  if (showSorterTooltip === undefined || showSorterTooltip === true) {
    return { mouseEnterDelay: APP_TOOLTIP_MOUSE_ENTER_DELAY_SECONDS };
  }
  return {
    ...showSorterTooltip,
    mouseEnterDelay: withMinimumTooltipDelay(showSorterTooltip.mouseEnterDelay),
  };
}

/**
 * Таблицы справочников (внутри `LocalizedList`): заголовок колонки — до двух строк с переносом по словам, остальное за «…»
 * (полный текст — в подсказке). Стили — `.reference-table` в `styles/app.css`.
 */
export const ReferenceTableContext = React.createContext(false);

/** Ячейка заголовка: простой текст оборачивается в блок с обрезкой по двум строкам; сложное содержимое (сортировка, фильтр) не трогается. */
export const ReferenceHeaderCell: React.FC<React.ThHTMLAttributes<HTMLTableCellElement>> = ({ children, ...rest }) => {
  const parts = React.Children.toArray(children);
  const text = parts.every((part) => typeof part === 'string' || typeof part === 'number') ? parts.join('') : '';
  return (
    <th {...rest} title={rest.title ?? (text || undefined)}>
      {text ? <span className="reference-table__title">{children}</span> : children}
    </th>
  );
};

const DelayedTable = React.forwardRef<HTMLDivElement, AntdTableProps<any>>((props, ref) => {
  const { showSorterTooltip, ...rest } = props;
  const reference = React.useContext(ReferenceTableContext);
  const referenceProps: Partial<AntdTableProps<any>> = reference ? {
    className: [rest.className, 'reference-table'].filter(Boolean).join(' '),
    components: { ...rest.components, header: { cell: ReferenceHeaderCell, ...rest.components?.header } },
  } : {};
  return (
    <AntdTable
      {...rest}
      {...referenceProps}
      ref={ref}
      showSorterTooltip={withDelayedSorterTooltip(showSorterTooltip)}
    />
  );
});

const TableWithStatics = Object.assign(DelayedTable, AntdTable);
DelayedTable.displayName = 'Table';

export const Table: typeof AntdTable = TableWithStatics;
