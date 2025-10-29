// Order Aggregates Display
// Read-only display of calculated values: Parts Count, Total Area

import React from 'react';
import { Card, Statistic, Row, Col } from 'antd';
import { FileTextOutlined, ColumnHeightOutlined } from '@ant-design/icons';
import { useOrderFormStore, selectTotals } from '../../../../stores/orderFormStore';
import { useShallow } from 'zustand/react/shallow';

export const OrderAggregatesDisplay: React.FC = () => {
  const totals = useOrderFormStore(useShallow(selectTotals));

  return (
    <Card title="Итоговые показатели" size="small">
      <Row gutter={16}>
        <Col span={8}>
          <Statistic
            title="Количество деталей"
            value={totals.parts_count}
            prefix={<FileTextOutlined />}
            suffix="шт"
          />
        </Col>
        <Col span={8}>
          <Statistic
            title="Общая площадь"
            value={totals.total_area}
            precision={2}
            prefix={<ColumnHeightOutlined />}
            suffix="м²"
          />
        </Col>
        <Col span={8}>
          <Statistic
            title="Оплачено"
            value={totals.total_paid}
            precision={2}
            suffix="₽"
          />
        </Col>
      </Row>
    </Card>
  );
};
