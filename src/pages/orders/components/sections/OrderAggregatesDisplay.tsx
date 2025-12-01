// Order Aggregates Display
// Read-only display of calculated values: Parts Count, Total Area

import React, { useMemo } from 'react';
import { Card, Statistic, Row, Col } from 'antd';
import { FileTextOutlined, ColumnHeightOutlined } from '@ant-design/icons';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';

export const OrderAggregatesDisplay: React.FC = () => {
  const { details, payments } = useOrderFormStore();

  // FIX: Calculate totals directly from details/payments for proper reactivity
  const totals = useMemo(() => ({
    positions_count: details.length,
    parts_count: details.reduce((sum, d) => sum + (d.quantity || 0), 0),
    total_area: details.reduce((sum, d) => sum + (d.area || 0), 0),
    total_paid: payments.reduce((sum, p) => sum + (p.amount || 0), 0),
    total_amount: details.reduce((sum, d) => sum + (d.detail_cost || 0), 0),
  }), [details, payments]);

  return (
    <Card title="Итоговые показатели" size="small">
      <Row gutter={16}>
        <Col span={8}>
          <Statistic
            title="Количество деталей"
            value={formatNumber(totals.parts_count, 0)}
            prefix={<FileTextOutlined />}
            suffix="шт"
          />
        </Col>
        <Col span={8}>
          <Statistic
            title="Общая площадь"
            value={formatNumber(totals.total_area, 2)}
            prefix={<ColumnHeightOutlined />}
            suffix="м²"
          />
        </Col>
        <Col span={8}>
          <Statistic
            title="Оплачено"
            value={formatNumber(totals.total_paid, 2)}
            suffix={CURRENCY_SYMBOL}
          />
        </Col>
      </Row>
    </Card>
  );
};
