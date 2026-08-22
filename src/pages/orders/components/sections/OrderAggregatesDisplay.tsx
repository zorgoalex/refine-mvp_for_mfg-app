// Order Aggregates Display
// Read-only display of calculated values: Parts Count, Total Area

import React, { useMemo } from 'react';
import { Card, Statistic, Row, Col } from 'antd';
import { FileTextOutlined, ColumnHeightOutlined } from '@ant-design/icons';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import { calculateOrderTotalArea } from '../../../../utils/orderArea';
import { businessOrderDetails } from '../../../../utils/orderDetailRows';

export const OrderAggregatesDisplay: React.FC = () => {
  const { details, payments } = useOrderFormStore();
  const businessDetails = useMemo(
    () => businessOrderDetails(details),
    [details],
  );

  // FIX: Calculate totals directly from details/payments for proper reactivity
  const totals = useMemo(() => ({
    positions_count: businessDetails.length,
    parts_count: businessDetails.reduce((sum, d) => sum + (d.quantity || 0), 0),
    total_area: calculateOrderTotalArea(businessDetails),
    total_paid: payments.reduce((sum, p) => sum + (p.amount || 0), 0),
    total_amount: businessDetails.reduce((sum, d) => sum + (d.detail_cost || 0), 0),
  }), [businessDetails, payments]);

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
