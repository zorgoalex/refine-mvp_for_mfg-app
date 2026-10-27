import React from 'react';
import { Card, List, Tag, Typography } from 'antd';
import { StarFilled } from '@ant-design/icons';
import { ProductionStagesDisplay } from '../../../components/ProductionStagesDisplay';
import { resolveOrderStageCodes } from '../currentProductionStatus';
import type { TablePaginationConfig } from 'antd';
import { useOptionalUiVariant } from '../../../ui-variant/UiVariantProvider';
import { orderStatusTone } from '../orderListWorkbench';
import { workbenchDeadlineLine, workbenchPaymentLine, workbenchTotalLine } from './workbenchOrderCardModel';
import {
  buildOrderCardModel,
  getOrderCardStatusTextColor,
  type OrderCardStatusColorMaps,
  type OrderCardStatusKind,
} from './orderCardModel';

export interface OrderCardListProps {
  rows: readonly Record<string, unknown>[];
  loading?: boolean;
  pagination: TablePaginationConfig | false;
  onPaginationChange: (page: number, pageSize: number) => void;
  onOpen: (id: number) => void;
  showFinancials?: boolean;
  statusColors?: Partial<OrderCardStatusColorMaps>;
  /** Order-level stage marks by order id (legacy Hasura read path); backend rows carry their own. */
  passedCodesByOrderId?: Readonly<Record<number, string[]>>;
  productionWorkflowDisplay?: {
    displayOrderCodes?: string[];
    codeToLetter?: Record<string, string>;
    codeToName?: Record<string, string>;
  };
}

const statusTag = (kind: OrderCardStatusKind, label: string, backgroundColor: string) => (
  <Tag
    data-order-card-status={kind}
    style={{
      marginInlineEnd: 0,
      backgroundColor,
      borderColor: backgroundColor,
      color: getOrderCardStatusTextColor(backgroundColor),
      fontWeight: 600,
    }}
  >
    {label}
  </Tag>
);

export const buildOrderCardPagination = (
  pagination: TablePaginationConfig | false,
  onPaginationChange: (page: number, pageSize: number) => void,
) => {
  if (pagination === false) return false;

  // Table uses an array such as ['bottomRight']; Ant List accepts only
  // 'top' | 'bottom' | 'both'. Passing the table value makes List render no pager.
  const { position: _tablePosition, ...sharedPagination } = pagination;
  return {
    ...sharedPagination,
    position: 'bottom' as const,
    simple: false,
    showLessItems: true,
    showSizeChanger: true,
    onChange: onPaginationChange,
  };
};

export const OrderCardList: React.FC<OrderCardListProps> = ({
  rows, loading, pagination, onPaginationChange, onOpen, showFinancials = true, statusColors,
  passedCodesByOrderId, productionWorkflowDisplay,
}) => {
  const isWorkbench = useOptionalUiVariant()?.variant === 'workbench';
  return (
  <List
    className={isWorkbench ? 'wb-mcards' : undefined}
    dataSource={rows as Record<string, unknown>[]}
    loading={loading}
    pagination={buildOrderCardPagination(pagination, onPaginationChange)}
    rowKey={(r) => String(r.order_id)}
    renderItem={(row) => {
      const m = buildOrderCardModel(row, { showFinancials, statusColors });
      const stages = (
        <ProductionStagesDisplay
          passedCodes={resolveOrderStageCodes(row.passed_production_status_codes, passedCodesByOrderId?.[Number(row.order_id)])}
          displayOrderCodes={productionWorkflowDisplay?.displayOrderCodes}
          codeToLetter={productionWorkflowDisplay?.codeToLetter}
          codeToName={productionWorkflowDisplay?.codeToName}
          fontSize={11}
        />
      );
      if (isWorkbench) {
        const deadline = workbenchDeadlineLine(row);
        const payment = workbenchPaymentLine(row, showFinancials);
        const total = workbenchTotalLine(row, showFinancials);
        return (
          <div
            className="wb-mcard"
            role="link"
            tabIndex={0}
            onClick={() => onOpen(m.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpen(m.id);
              }
            }}
          >
            <div className="wb-mcard__r1">
              <span className="wb-mcard__no">
                {m.priority && <StarFilled className="wb-mcard__star" aria-label="Срочный" />}
                {m.title}
              </span>
              <span className="wb-mcard__client">{m.client}</span>
              {m.statusTag ? (
                <span className="wb-pill" data-tone={orderStatusTone(m.statusTag)} data-order-card-status="order">{m.statusTag}</span>
              ) : null}
            </div>
            <div className="wb-mcard__r2">
              <span data-tone={deadline?.tone}>{deadline?.text ?? m.dates}</span>
              {total ? (
                <span className="wb-mcard__money">
                  <b>{total}</b>
                  {payment ? <small data-tone={payment.tone}>{payment.text}</small> : null}
                </span>
              ) : null}
            </div>
            <div className="wb-mcard__stages">{stages}</div>
          </div>
        );
      }
      return (
        <Card
          size="small"
          style={{ marginBottom: 8 }}
          onClick={() => onOpen(m.id)}
          hoverable
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <Typography.Text strong ellipsis style={{ minWidth: 0 }}>
              {m.priority && <StarFilled style={{ color: '#faad14', marginRight: 4 }} />}
              {m.title}
            </Typography.Text>
            <Typography.Text type="secondary">#{m.id}</Typography.Text>
          </div>
          <div style={{ marginTop: 4 }}>
            <Typography.Text ellipsis style={{ display: 'block' }}>{m.client}</Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block' }}>{m.dates}</Typography.Text>
          </div>
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {m.statusTag && statusTag('order', m.statusTag, m.statusTagColor)}
            {m.paymentTag && statusTag('payment', m.paymentTag, m.paymentTagColor)}
            {stages}
          </div>
          {m.amountLine && (
            <Typography.Text strong style={{ display: 'block', marginTop: 6 }}>{m.amountLine}</Typography.Text>
          )}
        </Card>
      );
    }}
  />
  );
};
