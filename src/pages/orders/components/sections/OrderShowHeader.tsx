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
  dowelingLinks?: any[]; // doweling links with nested doweling_order
}

export const OrderShowHeader: React.FC<OrderShowHeaderProps> = ({ record, details, dowelingLinks = [] }) => {
  // Get the latest (last added) doweling link for header display
  const latestDowelingLink = useMemo(() => {
    if (!dowelingLinks || dowelingLinks.length === 0) return null;
    return dowelingLinks[dowelingLinks.length - 1];
  }, [dowelingLinks]);

  // Load employees for design_engineer lookup
  const { data: employeesData } = useList({
    resource: 'employees',
    pagination: { pageSize: 1000 },
  });

  const employeesMap = useMemo(() => new Map(
    (employeesData?.data || []).map((e: any) => [e.employee_id, e.full_name])
  ), [employeesData]);

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

  // Load client phones
  const { data: clientPhonesData } = useList({
    resource: 'client_phones',
    filters: [
      { field: 'client_id', operator: 'eq', value: record?.client_id },
    ],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: !!record?.client_id,
    },
  });

  // Format phone number as "8 xxx xxx xxxx"
  const formatPhone = (phone: string): string => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11) {
      return `8 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 11)}`;
    } else if (digits.length === 10) {
      return `8 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`;
    }
    return phone;
  };

  // Find primary phone (or first available)
  const primaryPhone = useMemo(() => {
    const phones = clientPhonesData?.data || [];
    const primary = phones.find((p: any) => p.is_primary);
    const phoneNumber = primary?.phone_number || phones[0]?.phone_number;
    return phoneNumber ? formatPhone(phoneNumber) : null;
  }, [clientPhonesData]);

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
      {/* Row 1: Order name, priority, status | Client | Discounted amount, discount %, payment status */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 16px',
          gap: 16,
          whiteSpace: 'nowrap',
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

        {/* Column 2: Client + Phone */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
          <Text strong style={{ fontSize: 16, color: '#111827' }}>
            {record?.client_name || '—'}
          </Text>
          {primaryPhone && (
            <>
              <span style={{ margin: '0 16px', color: '#E5E7EB' }}>|</span>
              <Text style={{ fontSize: 12.8, fontStyle: 'italic', color: '#111827' }}>
                <span style={{ fontVariant: 'small-caps' }}>Тел.:</span> {primaryPhone}
              </Text>
            </>
          )}
        </div>

        {/* Column 3: Final amount + Payment status */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
          <Text strong style={{ fontSize: 15, color: '#4F46E5' }}>
            {formatNumber(record?.final_amount || record?.total_amount || 0, 2)} {CURRENCY_SYMBOL}
          </Text>
          <Tag
            color={
              record?.payment_status_name === 'Оплачен' ? '#059669'
              : record?.payment_status_name === 'Частично оплачен' ? '#D97706'
              : '#D97706'
            }
            style={{ fontSize: '0.64em', padding: '2px 8px', margin: 0, fontWeight: 500, letterSpacing: '0.8px' }}
          >
            {record?.payment_status_name?.toUpperCase() || 'НЕ НАЗНАЧЕН'}
          </Tag>
        </div>
      </div>

      <RowSeparator />

      {/* Row 2: Dates | Notes | Total amount */}
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

        {/* Column 3: Discount/Surcharge | Paid | Remaining - двухстрочный стиль */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
          {(() => {
            const discount = Number(record?.discount) || 0;
            const surcharge = Number(record?.surcharge) || 0;
            const paidAmount = Number(record?.paid_amount) || 0;
            const totalAmount = Number(record?.total_amount) || 0;
            const finalAmount = Number(record?.final_amount) || totalAmount || 0;
            const remainingAmount = Math.max(0, finalAmount - paidAmount);

            const items: React.ReactNode[] = [];

            // Скидка (если > 0)
            if (discount > 0) {
              const discountPercent = totalAmount > 0 ? (discount / totalAmount) * 100 : 0;
              items.push(
                <span key="discount" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.1 }}>
                  <Text style={{ fontSize: 9.9, fontStyle: 'italic', color: '#111827', fontWeight: 400, letterSpacing: '0.5px', fontVariant: 'small-caps' }}>
                    Скидка {formatNumber(discountPercent, 1)}%:
                  </Text>
                  <Text style={{ fontSize: 12, fontStyle: 'italic', color: '#cf1322', fontWeight: 600 }}>
                    -{formatNumber(discount, 2)} {CURRENCY_SYMBOL}
                  </Text>
                </span>
              );
            }

            // Наценка (если > 0) - показываем как двойную голубую линию-индикатор
            if (surcharge > 0) {
              items.push(
                <span
                  key="surcharge"
                  title={`Наценка: +${formatNumber(surcharge, 2)} ${CURRENCY_SYMBOL}`}
                  style={{
                    display: 'inline-flex',
                    flexDirection: 'column',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    width: 40,
                    height: 28,
                    paddingBottom: 2,
                  }}
                >
                  <div style={{ width: '100%', height: 2, background: '#1890ff', marginBottom: 3 }} />
                  <div style={{ width: '100%', height: 2, background: '#1890ff' }} />
                </span>
              );
            }

            // Оплачено (если > 0)
            if (paidAmount > 0) {
              items.push(
                <span key="paid" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.1 }}>
                  <Text style={{ fontSize: 9.9, fontStyle: 'italic', color: '#111827', letterSpacing: '0.5px', fontVariant: 'small-caps' }}>
                    Оплачено:
                  </Text>
                  <Text strong style={{ fontSize: 12, fontStyle: 'italic', color: '#52c41a' }}>
                    {formatNumber(paidAmount, 2)} {CURRENCY_SYMBOL}
                  </Text>
                </span>
              );
            }

            // Осталось оплатить (если > 0)
            if (remainingAmount > 0) {
              items.push(
                <span key="remaining" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.1 }}>
                  <Text style={{ fontSize: 9.9, fontStyle: 'italic', color: '#111827', letterSpacing: '0.5px', fontVariant: 'small-caps' }}>
                    Остаток оплаты:
                  </Text>
                  <Text strong style={{ fontSize: 12, fontStyle: 'italic', color: '#D97706' }}>
                    {formatNumber(remainingAmount, 2)} {CURRENCY_SYMBOL}
                  </Text>
                </span>
              );
            }

            // Добавляем разделители между элементами
            return items.map((item, index) => (
              <React.Fragment key={index}>
                {index > 0 && <span style={{ color: '#E5E7EB', margin: '0 4px' }}>|</span>}
                {item}
              </React.Fragment>
            ));
          })()}
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
        {/* Doweling Order (Присадка) - показываем последнюю из many-to-many */}
        {latestDowelingLink && (
          <>
            <Text style={{ fontSize: 12, color: '#6B7280' }}>
              Присадка: <Text strong style={{ color: '#DC2626' }}>
                {latestDowelingLink.doweling_order?.doweling_order_name || '—'}
              </Text>
              {latestDowelingLink.doweling_order?.design_engineer_id && (
                <span style={{ marginLeft: 8, fontSize: 11.8, fontStyle: 'italic', letterSpacing: '0.3px', color: '#6B7280' }}>
                  Конструктор: <Text style={{ fontSize: 11.8, fontStyle: 'italic', letterSpacing: '0.3px', color: '#111827' }}>
                    {employeesMap.get(latestDowelingLink.doweling_order.design_engineer_id) || '—'}
                  </Text>
                </span>
              )}
              {dowelingLinks.length > 1 && (
                <span style={{ marginLeft: 4, color: '#6B7280' }}>
                  +{dowelingLinks.length - 1}
                </span>
              )}
            </Text>
            <div style={{ width: 1, height: 12, background: '#E5E7EB' }} />
          </>
        )}
        {/* Fallback для обратной совместимости (из orders_view) */}
        {!latestDowelingLink && record?.doweling_order_name && (
          <>
            <Text style={{ fontSize: 12, color: '#6B7280' }}>
              Присадка: <Text strong style={{ color: '#DC2626' }}>{record.doweling_order_name}</Text>
              {record?.design_engineer && (
                <span style={{ marginLeft: 8, fontSize: 11.8, fontStyle: 'italic', letterSpacing: '0.3px', color: '#6B7280' }}>
                  Конструктор: <Text style={{ fontSize: 11.8, fontStyle: 'italic', letterSpacing: '0.3px', color: '#111827' }}>{record.design_engineer}</Text>
                </span>
              )}
            </Text>
            <div style={{ width: 1, height: 12, background: '#E5E7EB' }} />
          </>
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
