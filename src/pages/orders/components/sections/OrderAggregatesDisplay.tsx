// Order Aggregates Display
// Read-only display of calculated values: Parts Count, Total Area

import React from 'react';
import { Card, Statistic, Row, Col } from 'antd';
import { FileTextOutlined, ColumnHeightOutlined } from '@ant-design/icons';
import { useOrderFormStore, selectTotals } from '../../../../stores/orderFormStore';
import { useShallow } from 'zustand/react/shallow';
import { formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';

export const OrderAggregatesDisplay: React.FC = () => {
  const totals = useOrderFormStore(useShallow(selectTotals));

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
