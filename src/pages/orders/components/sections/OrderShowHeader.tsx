// Order Show Header (Read-only summary for show page)
// Adapted from OrderHeaderSummary for use with props instead of store

import React, { useMemo } from 'react';
import { Tag, Space, Typography } from 'antd';
import { StarOutlined } from '@ant-design/icons';
import { useList } from '@refinedev/core';
import { formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import { getMaterialColor } from '../../../../config/displayColors';
import dayjs from 'dayjs';

const { Text } = Typography;

interface OrderShowHeaderProps {
  record: any; // order record from orders_view
  details: any[]; // order details array
}

export const OrderShowHeader: React.FC<OrderShowHeaderProps> = ({ record, details }) => {
  // Calculate totals from details
  const totals = useMemo(() => {
    const positions_count = details.length;
    const parts_count = details.reduce((sum, d) => sum + (d.quantity || 0), 0);
    const total_area = details.reduce((sum, d) => sum + (d.area || 0), 0);

    return {
      positions_count,
      parts_count,
      total_area,
    };
  }, [details]);

  // Get unique material IDs from details
  const uniqueMaterialIds = useMemo(() => {
    const ids = details
      .map(d => d.material_id)
      .filter((id): id is number => id !== null && id !== undefined);
    return [...new Set(ids)];
  }, [details]);

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

  // Row separator line
  const RowSeparator = () => (
    <div style={{ height: 1, background: '#E5E7EB', margin: 0 }} />
  );

  return (
    <div
      style={{
        marginBottom: 24,
        border: '1px solid #1890ff',
        borderRadius: 6,
        background: '#FFFFFF',
        overflow: 'hidden',
      }}
    >
      {/* Row 1: Order name, priority, status | Client | Total amount, payment status */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 16px',
          gap: 16,
        }}
      >
        {/* Column 1: Order name + Priority + Order status */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Text strong style={{ fontSize: 15, color: '#111827' }}>
            {record?.order_name || 'Заказ'}
          </Text>
          <Space size={8}>
            <span style={{ display: 'inline-flex', alignItems: 'center' }}>
              <StarOutlined
                style={{
                  fontSize: 14,
                  marginRight: 4,
                  color: record?.priority && record.priority <= 50 ? '#D97706' : '#6B7280'
                }}
              />
              <Text style={{ fontSize: 13, color: '#111827' }}>
                {record?.priority !== undefined ? formatNumber(record.priority, 0) : '—'}
              </Text>
            </span>
            <Tag
              color={
                record?.order_status_name === 'Готов к выдаче'
                  ? '#059669'
                  : record?.order_status_name === 'Предварительный'
                  ? '#91caff'
                  : '#4F46E5'
              }
              style={{ fontSize: '0.64em', padding: '2px 8px', margin: 0, fontWeight: 500, letterSpacing: '0.8px' }}
            >
              {record?.order_status_name?.toUpperCase() || 'НЕ НАЗНАЧЕН'}
            </Tag>
          </Space>
        </div>

        {/* Column 2: Client */}
        <div style={{ flex: 1 }}>
          <Text strong style={{ fontSize: 14, color: '#111827' }}>
            {record?.client_name || '—'}
          </Text>
        </div>

        {/* Column 3: Total amount + Payment status */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
          <Text strong style={{ fontSize: 15, color: '#111827' }}>
            {formatNumber(record?.total_amount || 0, 2)} {CURRENCY_SYMBOL}
          </Text>
          <Tag
            color={
              record?.payment_status_name === 'Оплачен' ? '#059669' : '#D97706'
            }
            style={{ fontSize: '0.64em', padding: '2px 8px', margin: 0, fontWeight: 500, letterSpacing: '0.8px' }}
          >
            {record?.payment_status_name?.toUpperCase() || 'НЕ НАЗНАЧЕН'}
          </Tag>
        </div>
      </div>

      <RowSeparator />

      {/* Row 2: Dates | Notes | Discounted amount & discount % */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 16px',
          gap: 16,
        }}
      >
        {/* Column 1: Dates */}
        <div style={{ flex: 1 }}>
          <Text style={{ fontSize: 13, color: '#111827' }}>
            {record?.order_date ? dayjs(record.order_date).format('DD.MM.YYYY') : '—'}
            {' → '}
            {record?.planned_completion_date ? dayjs(record.planned_completion_date).format('DD.MM.YYYY') : '—'}
          </Text>
        </div>

        {/* Column 2: Notes (with ellipsis) */}
        <div style={{ flex: 1 }}>
          <Text
            style={{
              fontSize: 13,
              color: '#6B7280',
              display: 'block',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={record?.notes || ''}
          >
            {record?.notes || '—'}
          </Text>
        </div>

        {/* Column 3: Discounted amount + discount % */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
          <Text strong style={{ fontSize: 14, color: '#4F46E5' }}>
            {formatNumber(record?.discounted_amount || 0, 2)} {CURRENCY_SYMBOL}
          </Text>
          <Text style={{ fontSize: 13, color: '#DC2626' }}>
            -{formatNumber(record?.discount || 0, 1)}%
          </Text>
        </div>
      </div>

      <RowSeparator />

      {/* Row 3: ID + Materials + Production metrics */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '6px 16px',
          gap: 16,
          background: '#FAFBFC',
        }}
      >
        {/* ID */}
        {record?.order_id && (
          <Text style={{ fontSize: 12, color: '#6B7280' }}>
            ID{record.order_id}
          </Text>
        )}

        {/* Separator */}
        {record?.order_id && (
          <div style={{ width: 1, height: 12, background: '#E5E7EB' }} />
        )}

        {/* Materials */}
        <div style={{ flex: 1 }}>
          <Text style={{ fontSize: 12, color: '#6B7280' }}>Материал: </Text>
          {materialsSummary === '—' ? (
            <Text style={{ fontSize: 12, color: '#6B7280' }}>—</Text>
          ) : (
            materialsData?.data?.map((material, index) => {
              const materialName = material.material_name || '';
              const color = getMaterialColor(materialName);

              return (
                <React.Fragment key={material.material_id}>
                  {index > 0 && <Text style={{ fontSize: 12, color: '#6B7280' }}>, </Text>}
                  <Text strong style={{ fontSize: 12, color }}>
                    {materialName}
                  </Text>
                </React.Fragment>
              );
            })
          )}
        </div>

        {/* Separator */}
        <div style={{ width: 1, height: 12, background: '#E5E7EB' }} />

        {/* Production metrics */}
        <Space size={16}>
          <Text style={{ fontSize: 12, color: '#111827' }}>
            Позиций: <Text strong>{formatNumber(totals.positions_count, 0)}</Text>
          </Text>
          <Text style={{ fontSize: 12, color: '#111827' }}>
            Деталей: <Text strong>{formatNumber(totals.parts_count, 0)}</Text>
          </Text>
          <Text style={{ fontSize: 12, color: '#111827' }}>
            Площадь: <Text strong>{formatNumber(totals.total_area, 2)} м²</Text>
          </Text>
        </Space>
      </div>
    </div>
  );
};
