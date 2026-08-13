import React from 'react';
import AntdPopover, { type PopoverProps as AntdPopoverProps } from 'antd/es/popover';
import AntdTable, { type TableProps as AntdTableProps } from 'antd/es/table';
import AntdTooltip, { type TooltipProps as AntdTooltipProps } from 'antd/es/tooltip';

export type { PopoverProps } from 'antd/es/popover';
export type { TablePaginationConfig, TableProps } from 'antd/es/table';
export type { TooltipProps } from 'antd/es/tooltip';

export const APP_TOOLTIP_MOUSE_ENTER_DELAY_SECONDS = 0.45;

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

const DelayedTable = React.forwardRef<HTMLDivElement, AntdTableProps<any>>((props, ref) => {
  const { showSorterTooltip, ...rest } = props;
  return (
    <AntdTable
      {...rest}
      ref={ref}
      showSorterTooltip={withDelayedSorterTooltip(showSorterTooltip)}
    />
  );
});

Object.assign(DelayedTable, AntdTable);
DelayedTable.displayName = 'Table';

export const Table = DelayedTable as typeof AntdTable;
