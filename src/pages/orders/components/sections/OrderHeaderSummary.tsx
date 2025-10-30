// Order Header Summary (Read-only)
// Improved visual design with grouping, hierarchy, and better scannability

import React, { useMemo } from 'react';
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
import { useOne, useList } from '@refinedev/core';
import { useOrderFormStore, selectTotals } from '../../../../stores/orderFormStore';
import { useShallow } from 'zustand/react/shallow';
import { formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import dayjs from 'dayjs';

const { Text, Title } = Typography;

export const OrderHeaderSummary: React.FC = () => {
  const { header, details } = useOrderFormStore();
  const totals = useOrderFormStore(useShallow(selectTotals));

  // Get unique material IDs from details
  const uniqueMaterialIds = useMemo(() => {
    const ids = details
      .map(d => d.material_id)
      .filter((id): id is number => id !== null && id !== undefined);
    return [...new Set(ids)];
  }, [details]);

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

  // Load materials list
  const { data: materialsData } = useList({
    resource: 'materials',
    filters: uniqueMaterialIds.length > 0 ? [
      { field: 'material_id', operator: 'in', value: uniqueMaterialIds }
    ] : [],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: uniqueMaterialIds.length > 0,
    },
  });

  // Create materials summary string
  const materialsSummary = useMemo(() => {
    if (!materialsData?.data || materialsData.data.length === 0) return '—';
    return materialsData.data
      .map(m => m.material_name)
      .filter(Boolean)
      .join(', ');
  }, [materialsData]);

  // Info item component with icon
  const InfoItem: React.FC<{
    icon: React.ReactNode;
    label: string;
    value: React.ReactNode;
    highlight?: boolean;
  }> = ({ icon, label, value, highlight }) => (
    <Space align="start" size={8} style={{ minHeight: 44 }}>
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
    <div style={{ minHeight: 44, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
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
    const fontSize = size === 'large' ? 16 : size === 'medium' ? 14 : 12;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Text type="secondary" style={{ fontSize: 9 }}>
          {label.toUpperCase()}
        </Text>
        <div>
          <Text
            strong
            style={{
              fontSize,
              color: color || '#262626',
              lineHeight: 1,
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
          background: 'white',
          border: '2px solid #1890ff',
          padding: '12px 20px',
          borderRadius: '8px 8px 0 0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Title level={5} style={{ margin: 0, color: '#262626', fontSize: 16 }}>
          {header.order_name ? `ЗАКАЗ "${header.order_name}"` : 'НОВЫЙ ЗАКАЗ'}
        </Title>
        <Space size="middle">
          <span style={{ display: 'inline-flex', alignItems: 'center', color: '#262626' }}>
            <StarOutlined
              style={{
                fontSize: 16,
                marginRight: 6,
                color: header.priority && header.priority <= 50 ? '#faad14' : '#8c8c8c'
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
      <Card size="small" style={{ borderRadius: '0 0 8px 8px', border: '2px solid #1890ff', borderTop: 'none' }}>
        <Row gutter={[24, 16]}>
          {/* Left column - Key parties */}
          <Col xs={24} md={12} lg={8}>
            <InfoItem
              icon={<UserOutlined />}
              label="Клиент"
              value={clientData?.data?.client_name || '—'}
              highlight
            />
            {/* Divider */}
            <div
              style={{
                height: 1,
                background: '#d9d9d9',
                margin: '14px 0',
              }}
            />
            <InfoItem
              icon={<SolutionOutlined />}
              label="Менеджер"
              value={managerData?.data?.full_name || '—'}
            />
            {header.order_id && (
              <div style={{ marginTop: 16 }}>
                <Text type="secondary" style={{ fontSize: 11, display: 'block', lineHeight: 1.2 }}>
                  ID ЗАКАЗА
                </Text>
                <Text style={{ fontSize: 15, lineHeight: 1.3, color: '#8c8c8c' }}>
                  {header.order_id}
                </Text>
              </div>
            )}
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
            </Row>
            {/* Divider between date rows */}
            <div
              style={{
                height: 1,
                background: '#d9d9d9',
                margin: '14px 0',
              }}
            />
            <Row gutter={[12, 12]}>
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
          <Col xs={24} lg={8} style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div
              style={{
                padding: 8,
                background: '#fafafa',
                border: '1px solid #e8e8e8',
                borderRadius: 6,
                width: '50%',
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
                      color: totals.total_paid > 0 ? '#389e0d' : '#595959',
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
            padding: '5px 6px',
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: '100%' }}>
                <Text type="secondary" style={{ fontSize: 9, whiteSpace: 'nowrap' }}>
                  МАТЕРИАЛЫ ЗАКАЗА
                </Text>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <Text
                    style={{
                      fontSize: 12,
                      color: '#000000',
                      lineHeight: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={materialsSummary}
                  >
                    {materialsSummary}
                  </Text>
                </div>
              </div>
            </Col>
          </Row>
        </div>
      </Card>
    </div>
  );
};
