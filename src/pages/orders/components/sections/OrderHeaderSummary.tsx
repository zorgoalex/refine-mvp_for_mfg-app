// Order Header Summary (Read-only)
// Improved visual design with grouping, hierarchy, and better scannability

import React from 'react';
import { Card, Row, Col, Tag, Space, Typography } from 'antd';
import {
  UserOutlined,
  SolutionOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  DollarOutlined,
  BarChartOutlined,
  StarOutlined,
} from '@ant-design/icons';
import { useOne } from '@refinedev/core';
import { useOrderFormStore, selectTotals } from '../../../../stores/orderFormStore';
import { useShallow } from 'zustand/react/shallow';
import { formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import dayjs from 'dayjs';

const { Text, Title } = Typography;

export const OrderHeaderSummary: React.FC = () => {
  const { header } = useOrderFormStore();
  const totals = useOrderFormStore(useShallow(selectTotals));

  // Load client name
  const { data: clientData } = useOne({
    resource: 'clients',
    id: header.client_id,
    queryOptions: {
      enabled: !!header.client_id,
    },
  });

  // Load order status
  const { data: orderStatusData } = useOne({
    resource: 'order_statuses',
    id: header.order_status_id,
    queryOptions: {
      enabled: !!header.order_status_id,
    },
  });

  // Load payment status
  const { data: paymentStatusData } = useOne({
    resource: 'payment_statuses',
    id: header.payment_status_id,
    queryOptions: {
      enabled: !!header.payment_status_id,
    },
  });

  // Load manager name
  const { data: managerData } = useOne({
    resource: 'employees',
    id: header.manager_id,
    queryOptions: {
      enabled: !!header.manager_id,
    },
  });

  // Info item component with icon
  const InfoItem: React.FC<{
    icon: React.ReactNode;
    label: string;
    value: React.ReactNode;
    highlight?: boolean;
  }> = ({ icon, label, value, highlight }) => (
    <Space align="start" size={8}>
      <div style={{ marginTop: 2, color: '#1890ff', fontSize: 16 }}>{icon}</div>
      <div>
        <Text type="secondary" style={{ fontSize: 11, display: 'block', lineHeight: 1.2 }}>
          {label.toUpperCase()}
        </Text>
        <Text strong={highlight} style={{ fontSize: 15, lineHeight: 1.3 }}>
          {value}
        </Text>
      </div>
    </Space>
  );

  // Date item component
  const DateItem: React.FC<{ icon: React.ReactNode; label: string; date?: string }> = ({
    icon,
    label,
    date,
  }) => (
    <div>
      <Text type="secondary" style={{ fontSize: 10, display: 'block' }}>
        {icon} {label.toUpperCase()}
      </Text>
      <Text strong style={{ fontSize: 16 }}>
        {date ? dayjs(date).format('DD.MM.YYYY') : '—'}
      </Text>
    </div>
  );

  // Stat item for financial/production metrics
  const StatItem: React.FC<{
    label: string;
    value: string | number;
    suffix?: string;
    color?: string;
    size?: 'small' | 'medium' | 'large';
  }> = ({ label, value, suffix, color, size = 'medium' }) => {
    const fontSize = size === 'large' ? 14 : size === 'medium' ? 12 : 10;
    return (
      <div>
        <Text type="secondary" style={{ fontSize: 8, display: 'block', marginBottom: 0 }}>
          {label.toUpperCase()}
        </Text>
        <div>
          <Text
            strong
            style={{
              fontSize,
              color: color || '#262626',
              lineHeight: 1.1,
            }}
          >
            {value}
          </Text>
          {suffix && (
            <Text style={{ fontSize: fontSize * 0.55, marginLeft: 2, color: '#8c8c8c' }}>
              {suffix}
            </Text>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Header bar with order name and status badges */}
      <div
        style={{
          background: 'linear-gradient(135deg, #a8b5f0 0%, #b899d4 100%)',
          padding: '12px 20px',
          borderRadius: '8px 8px 0 0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Title level={5} style={{ margin: 0, color: 'white', fontSize: 16 }}>
          ЗАКАЗ №{header.order_id || 'Новый'}
          {header.order_name && ` — ${header.order_name}`}
        </Title>
        <Space size="middle">
          <span style={{ display: 'inline-flex', alignItems: 'center', color: 'white' }}>
            <StarOutlined
              style={{
                fontSize: 16,
                marginRight: 6,
                color: header.priority && header.priority <= 50 ? '#ffd666' : 'white'
              }}
            />
            <span style={{ fontSize: 16, fontWeight: 'normal' }}>
              {header.priority !== undefined ? formatNumber(header.priority, 0) : '—'}
            </span>
          </span>
          <Tag
            color={orderStatusData?.data?.order_status_name === 'Готов к выдаче' ? '#87d068' : '#5b8ff9'}
            style={{ fontSize: 11, padding: '4px 12px', margin: 0, fontWeight: 'bold', letterSpacing: '0.8px' }}
          >
            {orderStatusData?.data?.order_status_name?.toUpperCase() || 'НЕ НАЗНАЧЕН'}
          </Tag>
          <Tag
            color={
              paymentStatusData?.data?.payment_status_name === 'Оплачен' ? '#87d068' : '#ffc069'
            }
            style={{ fontSize: 11, padding: '4px 12px', margin: 0, fontWeight: 'bold', letterSpacing: '0.8px' }}
          >
            {paymentStatusData?.data?.payment_status_name?.toUpperCase() || 'НЕ НАЗНАЧЕН'}
          </Tag>
        </Space>
      </div>

      {/* Main info section */}
      <Card size="small" style={{ borderRadius: '0 0 8px 8px', borderTop: 'none' }}>
        <Row gutter={[24, 16]}>
          {/* Left column - Key parties */}
          <Col xs={24} md={12} lg={8}>
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <InfoItem
                icon={<UserOutlined />}
                label="Клиент"
                value={clientData?.data?.client_name || '—'}
                highlight
              />
              <InfoItem
                icon={<SolutionOutlined />}
                label="Менеджер"
                value={managerData?.data?.full_name || '—'}
              />
            </Space>
          </Col>

          {/* Middle column - Dates */}
          <Col xs={24} md={12} lg={8}>
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <DateItem
                  icon={<CalendarOutlined />}
                  label="Дата заказа"
                  date={header.order_date}
                />
              </Col>
              <Col span={12}>
                <DateItem
                  icon={<CalendarOutlined />}
                  label="Плановая дата"
                  date={header.planned_completion_date}
                />
              </Col>
              <Col span={12}>
                <DateItem
                  icon={<CheckCircleOutlined />}
                  label="Дата завершения"
                  date={header.completion_date}
                />
              </Col>
              <Col span={12}>
                <DateItem
                  icon={<CheckCircleOutlined />}
                  label="Дата выдачи"
                  date={header.issue_date}
                />
              </Col>
            </Row>
          </Col>

          {/* Right column - Financial summary */}
          <Col xs={24} lg={8}>
            <div
              style={{
                padding: 8,
                background: '#fafafa',
                border: '1px solid #e8e8e8',
                borderRadius: 6,
              }}
            >
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Row justify="space-between">
                  <Text type="secondary" style={{ fontSize: 10 }}>
                    Сумма заказа
                  </Text>
                  <Text strong style={{ fontSize: 13 }}>
                    {formatNumber(header.total_amount || 0, 2)} {CURRENCY_SYMBOL}
                  </Text>
                </Row>
                <Row justify="space-between">
                  <Text type="secondary" style={{ fontSize: 10 }}>
                    Скидка
                  </Text>
                  <Text style={{ fontSize: 13, color: '#ff7875' }}>
                    {formatNumber(header.discount || 0, 2)}%
                  </Text>
                </Row>
                <Row justify="space-between" style={{ paddingTop: 4, borderTop: '1px solid #e8e8e8' }}>
                  <Text type="secondary" style={{ fontSize: 10 }}>
                    Со скидкой
                  </Text>
                  <Text strong style={{ fontSize: 14, color: '#5b8ff9' }}>
                    {formatNumber(header.discounted_amount || 0, 2)} {CURRENCY_SYMBOL}
                  </Text>
                </Row>
                <Row justify="space-between" style={{ paddingTop: 4, borderTop: '1px solid #e8e8e8' }}>
                  <Text type="secondary" style={{ fontSize: 10 }}>
                    Оплачено
                  </Text>
                  <Text
                    strong
                    style={{
                      fontSize: 14,
                      color: totals.total_paid > 0 ? '#73d13d' : '#8c8c8c',
                    }}
                  >
                    {formatNumber(totals.total_paid, 2)} {CURRENCY_SYMBOL}
                  </Text>
                </Row>
              </Space>
            </div>
          </Col>
        </Row>

        {/* Production metrics */}
        <div
          style={{
            marginTop: 16,
            padding: 6,
            background: '#fafafa',
            border: '1px solid #e8e8e8',
            borderRadius: 6,
          }}
        >
          <Row gutter={16}>
            <Col xs={12} sm={6}>
              <StatItem
                label="Позиций"
                value={formatNumber(totals.positions_count, 0)}
                size="large"
                color="#000000"
              />
            </Col>
            <Col xs={12} sm={6}>
              <StatItem
                label="Деталей"
                value={formatNumber(totals.parts_count, 0)}
                suffix="шт"
                size="large"
                color="#000000"
              />
            </Col>
            <Col xs={12} sm={6}>
              <StatItem
                label="Площадь"
                value={formatNumber(totals.total_area, 2)}
                suffix="м²"
                size="large"
                color="#000000"
              />
            </Col>
            <Col xs={12} sm={6}>
              <StatItem
                label="Средн. площадь детали"
                value={
                  totals.positions_count > 0
                    ? formatNumber(totals.total_area / totals.positions_count, 3)
                    : 0
                }
                suffix="м²"
                size="small"
                color="#000000"
              />
            </Col>
          </Row>
        </div>
      </Card>
    </div>
  );
};
